// Approved execution of ONE action, end to end without the installed extension:
//  - the REAL sidepanel.js / actions.js / targets.js / executor.js run in Node (fake-panel.js),
//  - chrome.scripting.executeScript is bridged to a REAL headless Chrome page (DevTools protocol),
//    so the page-side functions run against a real DOM,
//  - the "model" is a scripted reply (no Ollama): this tests approval, validation and dispatch,
//  - fixtures are served from a local http server so the panel's http(s) gate applies.
// The page functions run in the page's MAIN world here and in an ISOLATED world in the extension;
// they read the same DOM. Not the installed extension.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { load } = require("./fake-panel.js");
const root = path.join(__dirname, "..");
const out = path.join(__dirname, ".out");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 300) : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A gate that never opens must not hang the run: report what passed so far and stop.
setTimeout(() => { console.log(results.join("\n")); console.error("exec test: TIMED OUT after 300 s (a gated step never happened)"); process.exit(3); }, 300000).unref();

const LOGGER = `<script>window.__log=[];
document.addEventListener('click',e=>__log.push('click:'+((e.target.textContent||e.target.name||e.target.localName)+'').trim()),true);
document.addEventListener('input',e=>__log.push('input:'+(e.target.name||e.target.id)+':'+e.inputType));
document.addEventListener('keydown',e=>__log.push('key:'+e.key));
document.addEventListener('submit',e=>{__log.push('submit');e.preventDefault();});</script>`;
// Search pages: the log also goes to sessionStorage (it survives the navigation) and a submit is NOT cancelled.
const LOGGER_P = `<script>window.__log=[];
const __push=(m)=>{__log.push(m);try{const a=JSON.parse(sessionStorage.getItem('__slog')||'[]');a.push(m);sessionStorage.setItem('__slog',JSON.stringify(a));}catch(_){}};
document.addEventListener('click',e=>__push('click:'+((e.target.textContent||e.target.name||e.target.localName)+'').trim()),true);
document.addEventListener('input',e=>__push('input:'+(e.target.name||e.target.id)+':'+e.inputType));
document.addEventListener('keydown',e=>__push('key:'+e.key));
document.addEventListener('submit',()=>__push('submit'));</script>`;
const pageP = (title, body, extra = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${LOGGER_P}${extra}</body></html>`;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SEARCH_BOX = (attrs = "") => `<input type="search" name="q" aria-label="Search" autocomplete="off" ${attrs}>`;
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${LOGGER}</body></html>`;
const PAGES = {
  "/search.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}<button type="submit">Search</button></form></header>
<main><h1>Shoes shop</h1><form action="/subscribe" method="post"><label>Email <input type="text" name="email"></label><button type="submit">Subscribe</button></form><a href="/index.html">Home</a></main>`),
  "/search-prefilled.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX('value="black Nike shoes"')}<button type="submit">Search</button></form></header><main><h1>Shoes shop</h1></main>`),
  "/search-form-only.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}</form></header><main><h1>Shoes shop</h1></main>`),
  "/search-validation.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get"><input type="search" name="q" aria-label="Search" required pattern="[a-z ]+"></form></header><main><h1>Shoes shop</h1></main>`),
  "/search-ambiguous.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}<button type="submit">Alpha</button><button type="submit">Beta</button></form></header><main><h1>Shoes shop</h1></main>`),
  "/search-plain.html": pageP("Newsletter", `<main><h1>Newsletter</h1><form action="/subscribe" method="post" id="newsletter"><label>Query <input type="text" name="q"></label><button type="submit">Join</button></form></main>`),
  "/search-landmark.html": pageP("Shoes shop", `<header><div role="search"><input type="text" aria-label="Search the shop"><button type="button" id="find" onclick="location.href='/results.html?q='+encodeURIComponent(document.querySelector('[role=search] input').value)">Find</button></div></header><main><h1>Shoes shop</h1></main>`),
  "/search-disabled.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}<button type="submit" disabled>Search</button></form></header><main><h1>Shoes shop</h1></main>`),
  "/search-settings.html": pageP("Settings", `<main><h1>Settings</h1><form action="/settings" method="post"><input type="search" name="filter" aria-label="Search"><label>Display name <input type="text" name="n"></label><button type="submit">Save</button></form></main>`),
  "/search-mutating.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}<button type="submit">Search</button></form></header><main><h1>Shoes shop</h1></main>`, `<script>document.querySelector('[name=q]').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });</script>`),
  "/search-disabling.html": pageP("Shoes shop", `<header><form role="search" action="/results.html" method="get">${SEARCH_BOX()}<button type="submit">Search</button></form></header><main><h1>Shoes shop</h1></main>`, `<script>document.querySelector('[name=q]').addEventListener('input', () => { document.querySelector('header button').disabled = true; });</script>`),
  "/form.html": page("Web form", `<main><h1>Web form</h1><form id="f">
<label>Text input <input type="text" id="my-text-id" name="my-text"></label><br>
<label>Prefilled <input type="text" name="prefilled" value="OLD_VALUE_MARK"></label><br>
<label>Password <input type="password" name="my-password"></label><br>
<label>Textarea <textarea name="my-textarea" rows="3"></textarea></label><br>
<label>Disabled input <input name="my-disabled" disabled placeholder="Disabled input"></label><br>
<label>Readonly input <input name="my-readonly" readonly value="Readonly input"></label><br>
<a href="/index.html">Return to index</a> <a id="js" href="javascript:window.__log.push('JS_LINK_RAN')">Script link</a>
<button type="submit">Submit</button></form></main>`),
  "/index.html": page("Index", `<main><h1>Index</h1><a href="/form.html">Web form</a></main>`),
  "/addremove.html": page("Add/Remove Elements", `<main><h1>Add/Remove Elements</h1>
<button type="button" onclick="addElement()">Add Element</button><div id="elements"></div></main>
<script>function addElement(){const b=document.createElement('button');b.className='added-manually';b.textContent='Delete';b.onclick=()=>b.remove();document.getElementById('elements').appendChild(b);}</script>`),
  "/tall.html": page("Tall page", `<main><h1>Tall</h1><button type="button" id="top">Top button</button><div style="height:4000px"></div><button type="button" id="far">Far button</button></main>`),
  "/short.html": page("Short page", `<main><h1>Short</h1><button type="button">Only button</button></main>`),
};

(async () => {
  const requests = []; // every URL the server was asked for (the tests count real search requests here)
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/results.html") {
      const q = u.searchParams.get("q") || "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageP(`Results for ${esc(q)}`, `<main><h1>Results for ${esc(q)}</h1><a href="/index.html">Item 1</a></main>`));
      return;
    }
    const body = PAGES[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body || "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const port = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(out, "profile_x" + port);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "--window-size=1280,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let ws;
  const cleanup = async () => {
    try { ws && ws.close(); } catch (_) {}
    chrome.kill();
    server.close();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    let targets = null;
    for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch (_) {} await sleep(250); }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // Evaluate in the page; waits for a navigation in progress to finish first.
    async function evalIn(expression) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true });
        if (r.result && !r.result.exceptionDetails && r.result.result) return r.result.result.value;
        if (r.error || (r.result && r.result.exceptionDetails && /context|navigat|destroyed/i.test(JSON.stringify(r.result.exceptionDetails)))) { await sleep(100); continue; }
        throw new Error(JSON.stringify(r.result && r.result.exceptionDetails).slice(0, 300));
      }
      throw new Error("page not available");
    }
    const open = async (p) => {
      await send("Page.navigate", { url: base + p });
      for (let i = 0; i < 80; i++) { await sleep(100); try { if ((await evalIn("document.readyState")) === "complete" && (await evalIn("location.pathname")) === p.split("?")[0]) break; } catch (_) {} }
      await sleep(100);
    };
    const log = async () => JSON.parse(await evalIn("JSON.stringify(window.__log || [])"));
    const clearLog = () => evalIn("window.__log.length = 0; 0");
    const settleAuto = async () => { await sleep(120); }; // let an automatic capture (started by a tab event) finish
    const valueOf = (sel) => evalIn(`document.querySelector(${JSON.stringify(sel)}).value`); // the TEST reads values; the extension never does
    const scrollY = () => evalIn("Math.round(window.scrollY)");

    // ---- the panel under test ----
    const p = load();
    const A = p.api;
    const { ids } = p;
    let settleCalls = 0;
    global.chrome.tabs.query = async () => [{ id: 7, url: await evalIn("location.href") }];
    global.chrome.tabs.get = async () => { settleCalls++; return { id: 7, status: "complete" }; };
    let gate = null; // optional: { func: "captureActionTargets"|"performApprovedAction", nth, reached, release }
    let calls = [];
    const seenCalls = {};
    p.setScript(async (o) => {
      const name = o.func.name;
      calls.push(name);
      seenCalls[name] = (seenCalls[name] || 0) + 1;
      if (gate && gate.func === name && seenCalls[name] === gate.nth) {
        gate.reached();
        await gate.wait;
      }
      const expr = `(function(){ try { return JSON.stringify({ ok: true, v: (${o.func.toString()}).apply(null, ${JSON.stringify(o.args || [])}) }); } catch (e) { return JSON.stringify({ ok: false, msg: String(e && e.message || e) }); } })()`;
      const r = JSON.parse(await evalIn(expr));
      if (!r.ok) throw new Error(r.msg);
      return [{ result: r.v }];
    });
    const idle = async () => { for (let i = 0; i < 600 && A.getInFlight(); i++) await sleep(25); };
    const click = async (el) => { el.fire("click"); await idle(); };
    const resetCounters = () => { calls = []; for (const k of Object.keys(seenCalls)) delete seenCalls[k]; };
    const idOf = (ctx, name, kind) => { for (const r of ctx.records.values()) if (r.name === name && (!kind || r.kind === kind)) return r.id; return null; };
    const nthDelete = (ctx, n) => [...ctx.records.values()].filter((r) => r.name === "Delete")[n - 1];
    const reply = (obj) => ({ ok: true, json: async () => ({ response: JSON.stringify(obj), prompt_eval_count: 5, total_duration: 1 }) });
    const blank = { rationale: "It matches the goal.", action: "click", target_id: "", text: "", direction: "", question: "", reason: "" };
    // Ask for a proposal; `build(ctx)` gives the scripted model reply.
    async function propose(goal, build) {
      p.state.fetchCalls = [];
      p.state.fetchImpl = async () => reply({ ...blank, ...build(A.getActionContext()) });
      ids["prompt-input"].value = goal;
      await click(ids["suggest-button"]);
    }
    const approve = () => ids["approve-button"];
    const approvable = () => approve().hidden === false && approve().disabled === false && A.getPendingApproval() !== null;
    const resultText = () => ["execution-action", "execution-status", "execution-effect", "execution-goal", "execution-page"].map((k) => ids[k].textContent).join(" | ");
    const dispatches = () => calls.filter((c) => c === "performApprovedAction").length;
    const view = () => p.actionView();

    // =========================================================================================
    // A. The page-side executor, called directly on a real DOM
    // =========================================================================================
    await open("/form.html");
    const LIMITS = A.TARGET_LIMITS;
    const runInPage = async (func, args) => JSON.parse(await evalIn(`JSON.stringify((${func.toString()}).apply(null, ${JSON.stringify(args)}))`));
    const tgtFunc = new Function(fs.readFileSync(path.join(root, "targets.js"), "utf8") + "\nreturn captureActionTargets;")();
    const exeFunc = A.performApprovedAction;
    const cap = () => runInPage(tgtFunc, [LIMITS]);
    const exe = (spec) => runInPage(exeFunc, [spec]);
    const byName = (c, name, kind) => c.targets.find((t) => t.name === name && (!kind || t.kind === kind));
    const specFor = (c, t, extra = {}) => ({ action: "click", token: c.documentToken, key: t.key, signature: t.signature, kind: t.kind, text: "", direction: "", step: 0, ...extra });

    let c1 = await cap();
    const textField = byName(c1, "Text input", "text-field");
    ok("A: every listed control has an identity key; keys are unique", c1.targets.every((t) => Number.isInteger(t.key) && t.key > 0) && new Set(c1.targets.map((t) => t.key)).size === c1.targets.length);
    const c1b = await cap();
    ok("A: keys are stable across captures even though nothing else is (same element, same key)", c1b.targets.every((t, i) => t.key === c1.targets[i].key));
    await evalIn("document.body.insertBefore(Object.assign(document.createElement('button'), {textContent: 'Early'}), document.body.firstChild); 0");
    const c1c = await cap();
    ok("A: adding a control EARLIER in the page shifts every E-number but not the identity keys", c1c.targets.length === c1.targets.length + 1 && c1c.targets.find((t) => t.name === "Text input").n !== textField.n && c1c.targets.find((t) => t.name === "Text input").key === textField.key);
    await open("/form.html");
    c1 = await cap();
    const tf = byName(c1, "Text input", "text-field");

    // typing: replaces without reading, no submit, input event, other fields untouched
    let r = await exe(specFor(c1, tf, { action: "type", text: "hello world" }));
    ok("A: type -> dispatched via insertText", r.ok === true && r.action === "type" && r.method === "insertText", JSON.stringify(r));
    ok("A: the text is in the field (read by the TEST, not by Cloudy)", (await valueOf("#my-text-id")) === "hello world");
    let lg = await log();
    ok("A: typing fired an input event and NOTHING else: no key presses, no submit, no click", lg.includes("input:my-text:insertText") && !lg.some((l) => l.startsWith("key:") || l === "submit" || l.startsWith("click:")), lg.join(","));
    const pre = byName(c1, "Prefilled", "text-field");
    r = await exe(specFor(c1, pre, { action: "type", text: "new text" }));
    ok("A: typing REPLACES an existing value (selected without being read)", r.ok && (await valueOf("[name=prefilled]")) === "new text");
    const ta = byName(c1, "Textarea", "text-area");
    r = await exe(specFor(c1, ta, { action: "type", text: "some notes" }));
    ok("A: textarea typing works", r.ok && (await valueOf("[name=my-textarea]")) === "some notes");
    const exeSrc = fs.readFileSync(path.join(root, "executor.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const typePart = exeSrc.slice(exeSrc.indexOf("if (!TYPE_KINDS.includes(cur.kind))"));
    ok("A: executor.js: TYPE never reads a value, presses Enter or submits; the only submit calls are the search route's control click and requestSubmit(); no form.submit(), no synthetic keys", !/\.value\b/.test(typePart) && !/\.defaultValue|\.textContent|\.innerText|\.placeholder|\.submit\(|KeyboardEvent|keydown|"Enter"/.test(exeSrc) && (exeSrc.match(/requestSubmit/g) || []).length === 1 && (exeSrc.match(/\.value\b/g) || []).length === 2);

    // blocked at the executor itself
    for (const [name, kind] of [["Password", "password-field"], ["Disabled input", "text-field"], ["Readonly input", "text-field"]]) {
      const t = byName(c1, name);
      const rr = await exe(specFor(c1, t, { action: "type", text: "hello" }));
      ok(`A: executor refuses typing into ${name}`, rr.ok === false, JSON.stringify(rr));
    }
    ok("A: ...and none of them changed (password, disabled, readonly)", (await valueOf("[name=my-password]")) === "" && (await valueOf("[name=my-disabled]")) === "" && (await valueOf("[name=my-readonly]")) === "Readonly input");
    r = await exe(specFor(c1, byName(c1, "Submit"), { action: "type", text: "hello" }));
    ok("A: executor refuses typing into a button", r.ok === false && r.code === "blocked", JSON.stringify(r));
    r = await exe(specFor(c1, tf, { action: "type", text: "line\nbreak" }));
    ok("A: executor refuses text with a line break", r.ok === false && r.code === "bad-request");
    r = await exe(specFor(c1, tf, { action: "type", text: "x".repeat(201) }));
    ok("A: executor refuses text over 200 characters", r.ok === false && r.code === "bad-request");
    r = await exe(specFor(c1, byName(c1, "Script link"), {}));
    ok("A: a javascript: link is not clicked", r.ok === false && r.code === "blocked" && !(await log()).includes("JS_LINK_RAN"), JSON.stringify(r));

    // stale / changed / hidden / missing / other document
    await clearLog();
    r = await exe({ ...specFor(c1, byName(c1, "Submit")), token: "0" });
    ok("A: wrong document token -> refused, nothing clicked", r.ok === false && r.code === "document-changed" && (await log()).length === 0);
    r = await exe({ ...specFor(c1, byName(c1, "Submit")), key: 987654 });
    ok("A: unknown identity key -> refused as missing (no look-alike chosen)", r.ok === false && r.code === "missing");
    await evalIn("document.querySelector('button[type=submit]').textContent = 'Submit now'; 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: the control was renamed after capture -> refused as changed", r.ok === false && r.code === "changed" && !(await log()).includes("click:Submit now"), JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('button[type=submit]').disabled = true; 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: the control was disabled after capture -> refused", r.ok === false && ["changed", "disabled"].includes(r.code), JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('[name=my-text]').readOnly = true; 0");
    r = await exe(specFor(c1, byName(c1, "Text input"), { action: "type", text: "hi" }));
    ok("A: the field became read-only after capture -> refused, value untouched", r.ok === false && (await valueOf("[name=my-text]")) === "", JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('button[type=submit]').style.display = 'none'; 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: the control became hidden -> refused", r.ok === false && r.code === "hidden", JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('button[type=submit]').remove(); 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: the control was removed -> refused (missing)", r.ok === false && r.code === "missing", JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("(() => { const o = document.querySelector('button[type=submit]'); const n = o.cloneNode(true); o.replaceWith(n); })(); 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: an identical-looking clone replaced the control -> refused, the clone is NOT clicked in its place", r.ok === false && (await log()).filter((l) => l.startsWith("click:")).length === 0, JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('[name=my-text]').setAttribute('name', 'my-password-field'); 0");
    r = await exe(specFor(c1, byName(c1, "Text input"), { action: "type", text: "hi" }));
    ok("A: the field now looks like a credential field -> refused", r.ok === false && r.code === "blocked" && (await valueOf("#my-text-id")) === "", JSON.stringify(r));
    await open("/form.html"); c1 = await cap();
    await evalIn("document.querySelector('button[type=submit]').style.cssText = 'position:absolute;top:5000px'; 0");
    r = await exe(specFor(c1, byName(c1, "Submit")));
    ok("A: the control moved offscreen -> refused (no silent scrolling)", r.ok === false && r.code === "offscreen" && (await scrollY()) === 0, JSON.stringify(r));

    // click: exactly one click, form not submitted by typing but a Submit click is a normal click
    await open("/form.html"); c1 = await cap(); await clearLog();
    r = await exe(specFor(c1, byName(c1, "Return to index")));
    ok("A: click on a link -> dispatched once", r.ok === true && r.action === "click");
    await open("/addremove.html"); const c2 = await cap(); await clearLog();
    r = await exe(specFor(c2, byName(c2, "Add Element")));
    lg = await log();
    ok("A: click Add Element -> exactly one click, one Delete button appeared", r.ok && lg.filter((l) => l.startsWith("click:")).length === 1 && (await evalIn("document.querySelectorAll('.added-manually').length")) === 1, lg.join(","));

    // scroll
    await open("/tall.html");
    const c3 = await cap();
    r = await exe({ action: "scroll", token: c3.documentToken, direction: "down", step: 640 });
    ok("A: scroll down by the approved bounded step (640 = 80% of an 800 px viewport)", r.ok && r.moved === 640 && (await scrollY()) === 640, JSON.stringify(r));
    r = await exe({ action: "scroll", token: c3.documentToken, direction: "down", step: 99999 });
    ok("A: an oversized step is bounded by the executor itself (at most 2000 px)", r.ok && r.moved <= 2000, JSON.stringify(r));
    await evalIn("window.scrollTo(0, document.documentElement.scrollHeight); 0");
    r = await exe({ action: "scroll", token: c3.documentToken, direction: "down", step: 640 });
    ok("A: scroll down at the bottom -> refused (impossible)", r.ok === false && r.code === "cannot-scroll" && /bottom/.test(r.reason), JSON.stringify(r));
    await evalIn("window.scrollTo(0, 0); 0");
    r = await exe({ action: "scroll", token: c3.documentToken, direction: "up", step: 640 });
    ok("A: scroll up at the top -> refused (impossible)", r.ok === false && r.code === "cannot-scroll" && /top/.test(r.reason), JSON.stringify(r));
    await evalIn("window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight - 100); 0");
    const before = await scrollY();
    r = await exe({ action: "scroll", token: c3.documentToken, direction: "down", step: 640 });
    ok("A: near the end the scroll is limited to what remains (never past the end)", r.ok && r.moved === 100 && (await scrollY()) === before + 100, JSON.stringify(r));
    r = await exe({ action: "scroll", token: "0", direction: "down", step: 640 });
    ok("A: scroll with another document's token -> refused", r.ok === false && r.code === "document-changed");
    await open("/short.html");
    const c4 = await cap();
    r = await exe({ action: "scroll", token: c4.documentToken, direction: "down", step: 640 });
    ok("A: a page that does not scroll -> refused", r.ok === false && r.code === "cannot-scroll", JSON.stringify(r));

    // =========================================================================================
    // B. The panel: approval, binding, consumption, refresh, refusal, result wording
    // =========================================================================================
    // ---- harmless typing (the web-form scenario) ----
    await open("/form.html");
    await propose("type hello world into the text input", (c) => ({ action: "type", target_id: idOf(c, "Text input", "text-field"), text: "hello world" }));
    let v = view();
    ok("B: a valid, fresh type proposal is eligible: Approve is shown, and says exactly what it will do", approvable() && /Type "hello world" into the text field "Text input"/.test(ids["approval-note"].textContent) && /does not submit the form/.test(ids["approval-note"].textContent) && /without reading what the field holds/.test(ids["approval-note"].textContent), ids["approval-note"].textContent);
    ok("B: nothing has been done yet (no dispatch, field empty)", dispatches() === 0 && (await valueOf("#my-text-id")) === "" && /Nothing has been executed; press Approve/.test(v.status));
    const approval1 = A.getPendingApproval();
    ok("B: the approval is bound to action, target key, text, tab and document", approval1.action === "type" && approval1.text === "hello world" && approval1.key === tf.key && approval1.tabId === 7 && approval1.documentToken === (await evalIn("String(performance.timeOrigin)")) && approval1.consumed === false);
    resetCounters(); p.state.fetchCalls = [];
    // double click: the second click finds nothing to approve
    ids["approve-button"].fire("click"); ids["approve-button"].fire("click"); ids["approve-button"].fire("click");
    await idle();
    ok("B: three rapid Approve clicks -> ONE dispatch", dispatches() === 1 && (await valueOf("#my-text-id")) === "hello world", String(dispatches()));
    ok("B: the approval is consumed and the button is gone", A.getPendingApproval() === null && approve().hidden === true && approve().disabled === true);
    ok("B: the identity key survived a regenerated capture (the fresh read had a new version, same element)", !!approval1.targetId && /^a\d+:E\d+$/.test(approval1.targetId) && A.getActionCounter() > Number(approval1.targetId.slice(1, approval1.targetId.indexOf(":"))));
    lg = await log();
    ok("B: typing sent input events only: no Enter, no submit", !lg.some((l) => l === "submit" || l.startsWith("key:")), lg.join(","));
    let rt = resultText();
    ok("B: result separates DISPATCHED from GOAL: dispatched yes, goal verified no", /Action dispatched/.test(ids["execution-status"].textContent) && /Goal verified: no/.test(ids["execution-goal"].textContent), rt);
    ok("B: the typing result says nothing was submitted and reports what the NEW CAPTURE shows (an ordinary field), not a claim of its own", /nothing was submitted/.test(ids["execution-effect"].textContent) && /new capture shows the field holds exactly "hello world"/.test(ids["execution-effect"].textContent));
    ok("B: the page was captured again and shown, with no further model call", /Page captured again as a\d+/.test(ids["execution-page"].textContent) && ids["after-details"].hidden === false && p.state.fetchCalls.length === 0, ids["execution-page"].textContent);
    await click(approve()); // a hidden button: nothing may happen
    A.approveProposal && (await A.approveProposal());
    await idle();
    ok("B: approving again (button or direct call) does nothing", dispatches() === 1);

    // ---- click Add Element ----
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    ok("B: click Add Element is eligible", approvable() && /Click the button "Add Element"/.test(ids["approval-note"].textContent));
    resetCounters(); await clearLog();
    await click(approve());
    lg = await log();
    ok("B: Add Element dispatched: exactly one click, a Delete button now exists", dispatches() === 1 && lg.filter((l) => l.startsWith("click:")).length === 1 && (await evalIn("document.querySelectorAll('.added-manually').length")) === 1, lg.join(","));
    ok("B: the observed effect comes from the new capture (controls 1 -> 2) and is labelled as observed, not as goal success", /number of controls went from 1 to 2/.test(ids["execution-effect"].textContent) && /Goal verified: no/.test(ids["execution-goal"].textContent), rt = resultText());
    ok("B: the new capture lists the new Delete button", /name: "Delete"/.test(ids["after-text"].textContent));

    // ---- new proposals / tab or document changes invalidate approval ----
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    ok("B: eligible before invalidation", approvable());
    await propose("what is on this page", () => ({ action: "ask_user", question: "Which control do you mean?" }));
    ok("B: a NEW proposal replaces the approval (an ask_user reply has nothing to approve)", A.getPendingApproval() === null && approve().hidden === true);
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    p.handlers.activated({ tabId: 99 });
    ok("B: switching tabs drops the approval", A.getPendingApproval() === null && approve().hidden === true);
    await settleAuto();
    resetCounters(); await A.approveProposal(); await idle();
    ok("B: ...and calling approve anyway dispatches nothing", dispatches() === 0);
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    p.handlers.updated(7, { status: "loading" });
    ok("B: a navigation event on the tab drops the approval", A.getPendingApproval() === null);
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    p.handlers.removed(7);
    ok("B: closing the tab drops the approval", A.getPendingApproval() === null);

    // ---- stale / changed targets between proposal and approval ----
    const stale = [
      ["the control was renamed", "document.querySelector('button').textContent = 'Add Elements'; 0", /Not done: the control changed/],
      ["the control was removed", "document.querySelector('button').remove(); 0", /Not done: the control is missing or hidden/],
      ["the control was hidden", "document.querySelector('button').style.display = 'none'; 0", /Not done: the control is missing or hidden/],
      ["the control was disabled", "document.querySelector('button').disabled = true; 0", /Not done: the control changed/],
      ["the control was replaced by an identical clone", "(() => { const o = document.querySelector('button'); o.replaceWith(o.cloneNode(true)); })(); 0", /Not done: the control is missing or hidden/],
      ["another control was added", "document.body.appendChild(Object.assign(document.createElement('button'), {textContent: 'Newcomer'})); 0", /Not done: the page changed since the proposal/],
      ["the page address changed", "history.pushState({}, '', '/elsewhere'); 0", /Not done: the page address changed/],
      ["the page was reloaded (new document, same address)", "location.reload(); 0", /Not done: the page was reloaded or replaced/],
    ];
    for (const [label, js, re] of stale) {
      await open("/addremove.html");
      await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
      const was = approvable();
      await evalIn(js);
      if (/reloaded/.test(label)) await sleep(400);
      resetCounters(); await clearLog();
      await click(approve());
      const clicks = (await log()).filter((l) => l.startsWith("click:")).length;
      ok(`B: ${label} -> refused ("${ids["execution-status"].textContent.slice(0, 60)}"), no dispatch, nothing clicked`, was && re.test(ids["execution-status"].textContent) && dispatches() === 0 && clicks === 0 && /Goal verified: no/.test(ids["execution-goal"].textContent) && A.getPendingApproval() === null, ids["execution-status"].textContent);
    }
    // credential-looking after the proposal (not part of the signature): the rules are applied again
    await open("/form.html");
    await propose("type hello world into the text input", (c) => ({ action: "type", target_id: idOf(c, "Text input", "text-field"), text: "hello world" }));
    await evalIn("document.querySelector('[name=my-text]').setAttribute('autocomplete', 'one-time-code'); 0");
    resetCounters();
    await click(approve());
    ok("B: the field turned credential-looking after the proposal -> blocked by the rules again, nothing typed", /blocked by Cloudy's safety rules/.test(ids["execution-status"].textContent) && dispatches() === 0 && (await valueOf("#my-text-id")) === "", ids["execution-status"].textContent);

    // ---- existing disabled / read-only / policy blocks: never offered ----
    await open("/form.html");
    const blocks = [
      ["a disabled field", (c) => ({ action: "type", target_id: idOf(c, "Disabled input"), text: "hello" }), /is disabled/],
      ["a read-only field", (c) => ({ action: "type", target_id: idOf(c, "Readonly input"), text: "hello" }), /is read-only/],
      ["a password field", (c) => ({ action: "type", target_id: idOf(c, "Password"), text: "hello" }), /unsupported in this milestone: password field/],
      ["text that is not in the goal", (c) => ({ action: "type", target_id: idOf(c, "Text input", "text-field"), text: "invented words" }), /not in your goal/],
      ["a token-shaped text", (c) => ({ action: "type", target_id: idOf(c, "Text input", "text-field"), text: ["sk", "live", "abcdefghijklmnopqrstuvwxyz0123"].join("_") }), /opaque secret or token|looks like a token/],
      ["a click on a text field (wrong action for the control)", (c) => ({ action: "click", target_id: idOf(c, "Text input", "text-field") }), /filled with "type"/],
    ];
    for (const [label, build, re] of blocks) {
      resetCounters();
      await propose(label.includes("token") ? ["sk", "live", "abcdefghijklmnopqrstuvwxyz0123"].join("_") : "type hello into the field", build);
      v = view();
      const isFormat = /wrong action/.test(label);
      ok(`B: ${label} -> rejected, no Approve, no dispatch (${isFormat ? "invalid format" : "blocked by rule"})`, v.rejected && !approvable() && dispatches() === 0 && v.checks.some((c) => re.test(c)) && (isFormat ? /not a valid target\/action format/.test(v.banner) && v.checks.some((c) => /^Invalid format:/.test(c)) : /blocked by Cloudy's safety rules/.test(v.banner) && v.checks.some((c) => /^Blocked by a rule:/.test(c))), v.banner + " | " + v.checks.join(" // "));
    }
    await propose("click the nothing", () => ({ action: "click", target_id: "a1:E999" }));
    v = view();
    ok("B: a made-up ID is an INVALID FORMAT, not a policy block", v.rejected && /not a valid target\/action format/.test(v.banner) && v.checks.some((c) => /^Invalid format:/.test(c)) && !approvable());

    // ---- scroll ----
    await open("/tall.html");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    ok("B: a possible scroll is eligible and says it is bounded", approvable() && /scrolls the page itself by a bounded amount/.test(ids["approval-note"].textContent));
    resetCounters();
    await click(approve());
    const y1 = await scrollY();
    ok("B: approved scroll moved the page by the bounded step (640 px), once", dispatches() === 1 && y1 === 640 && /scrolled down by 640 px \(position 0 to 640 of \d+\)/.test(ids["execution-effect"].textContent) && /new capture reads position 640/.test(ids["execution-effect"].textContent), ids["execution-effect"].textContent);
    await evalIn("window.scrollTo(0, document.documentElement.scrollHeight); 0");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    v = view();
    ok("B: scroll down at the bottom is REJECTED as impossible at proposal time (not valid with a warning), so no Approve", v.rejected && !approvable() && v.checks.some((c) => /^Blocked by a rule: This scroll is not possible: the page is already at the bottom/.test(c)) && !/Valid target\/action format/.test(v.banner));
    await evalIn("window.scrollTo(0, 0); 0");
    await propose("scroll up", () => ({ action: "scroll", direction: "up" }));
    v = view();
    ok("B: scroll up at the top is rejected as impossible", v.rejected && !approvable() && v.checks.some((c) => /This scroll is not possible: the page is already at the top/.test(c)));
    await open("/short.html");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    ok("B: a page that does not scroll is rejected as impossible", view().rejected && !approvable() && view().checks.some((c) => /This scroll is not possible: the page does not scroll/.test(c)));
    await open("/tall.html");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    ok("B: eligible before the page moves", approvable());
    await evalIn("window.scrollTo(0, document.documentElement.scrollHeight); 0");
    resetCounters();
    await click(approve());
    ok("B: the page reached the bottom before approval -> refused at dispatch time (the same check, applied again), no dispatch", /Not done: blocked by Cloudy's safety rules/.test(ids["execution-status"].textContent) && /already at the bottom/.test(ids["execution-status"].textContent) && dispatches() === 0, ids["execution-status"].textContent);
    await open("/tall.html");
    await propose("click the far button", (c) => ({ action: "click", target_id: idOf(c, "Far button") }));
    ok("B: an offscreen control is not offered for approval (scroll first)", !approvable() && /Not offered for approval: the control is not in view/.test(view().warnings.join("|")));

    // ---- Stop ----
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    resetCounters(); await clearLog();
    let reached; const reachedP = new Promise((r) => (reached = r));
    let release; const waitP = new Promise((r) => (release = r));
    gate = { func: "captureActionTargets", nth: 1, reached, wait: waitP };
    ids["approve-button"].fire("click");
    await reachedP; // the page is being read again: not dispatched yet
    ok("B: while the page is re-checked, Stop is available", ids["stop-button"].disabled === false && A.getActiveExecution() !== null && A.getActiveExecution().dispatching === false);
    ids["stop-button"].fire("click");
    ok("B: Stop before dispatch says nothing will be dispatched", /Nothing has been dispatched, and nothing will be/.test(ids.status.textContent));
    release(); gate = null;
    await idle();
    lg = await log();
    ok("B: Stop before dispatch -> cancelled: no dispatch call, nothing clicked", dispatches() === 0 && lg.filter((l) => l.startsWith("click:")).length === 0 && /Cancelled\. Nothing was dispatched/.test(ids["execution-status"].textContent) && /Goal verified: no/.test(ids["execution-goal"].textContent), resultText());
    ok("B: the approval stays consumed after a cancel", A.getPendingApproval() === null && approve().hidden === true);

    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    resetCounters(); await clearLog();
    let reached2; const reachedP2 = new Promise((r) => (reached2 = r));
    let release2; const waitP2 = new Promise((r) => (release2 = r));
    gate = { func: "performApprovedAction", nth: 1, reached: reached2, wait: waitP2 };
    ids["approve-button"].fire("click");
    await reachedP2; // dispatch has begun
    ids["stop-button"].fire("click");
    ok("B: Stop after dispatch began says it cannot undo", /already dispatched\. Stop cannot undo it/.test(ids.status.textContent), ids.status.textContent);
    release2(); gate = null;
    await idle();
    lg = await log();
    ok("B: ...the action still ran exactly once and is reported as dispatched (not as cancelled)", lg.filter((l) => l.startsWith("click:")).length === 1 && /Action dispatched/.test(ids["execution-status"].textContent) && !/Cancelled/.test(ids["execution-status"].textContent));
    ok("B: ...only the follow-up capture was skipped, and that is stated", /follow-up capture was skipped/.test(ids["execution-page"].textContent) && ids["after-details"].hidden === true, ids["execution-page"].textContent);

    // ---- a click that navigates ----
    await open("/form.html");
    await propose("go back to the index", (c) => ({ action: "click", target_id: idOf(c, "Return to index") }));
    resetCounters();
    await click(approve());
    ok("B: a link click that navigates is dispatched, and the new capture reports the navigation", /Action dispatched/.test(ids["execution-status"].textContent) && /(the page navigated or reloaded|the page address changed)/.test(ids["execution-effect"].textContent) && (await evalIn("location.pathname")) === "/index.html", resultText());

    // =========================================================================================
    // D. ONE Search operation, ONE approval (fill + submit), and "type" that never submits
    // =========================================================================================
    const slog = async () => JSON.parse(await evalIn("sessionStorage.getItem('__slog') || '[]'")); // survives the navigation
    const clearSlog = () => evalIn("sessionStorage.removeItem('__slog'); 0");
    const searchReqs = () => requests.filter((u) => u.startsWith("/results.html")).map((u) => new URL(u, "http://x").searchParams.get("q"));
    const fieldId = (c) => idOf(c, "Search", "text-field");
    const searchGoal = "search for black Nike shoes";
    const proposeSearch = (goal = searchGoal, text = "black Nike shoes") => propose(goal, (c) => ({ action: "search", target_id: fieldId(c), text }));
    const resolveOf = async (p2) => { await open(p2); const c = await cap(); const t = c.targets.find((x) => x.search); return t ? t.search : null; };

    // -- how each page's search is resolved, in a real DOM, before any approval --
    let rs = await resolveOf("/search.html");
    ok("D: search form with a visible Search button -> submit via that associated control", rs && rs.via === "control" && rs.submit.name === "Search" && rs.formKey > 0, JSON.stringify(rs));
    rs = await resolveOf("/search-form-only.html");
    ok("D: identified search form with NO submit control -> submit via form.requestSubmit()", rs && rs.via === "form" && rs.submit === null, JSON.stringify(rs));
    rs = await resolveOf("/search-ambiguous.html");
    ok("D: several submit buttons, none clearly 'search' -> ambiguous, not guessed", rs && rs.via === "ambiguous" && /several submit buttons/.test(rs.reason), JSON.stringify(rs));
    rs = await resolveOf("/search-plain.html");
    ok("D: a field named q inside an arbitrary (newsletter) form -> NOT submittable: that form is not a search form", rs && rs.via === "none" && /not identified as a search form/.test(rs.reason), JSON.stringify(rs));
    rs = await resolveOf("/search-landmark.html");
    ok("D: no form, but a search landmark with a Find button -> submit via that control", rs && rs.via === "control" && rs.submit.name === "Find" && rs.formKey === 0, JSON.stringify(rs));
    rs = await resolveOf("/search-settings.html");
    ok("D: a type=search filter box inside a larger settings form does NOT make that form a search form (it would not be submitted)", rs && rs.via === "none" && /not identified as a search form/.test(rs.reason), JSON.stringify(rs));
    rs = await resolveOf("/search-disabled.html");
    ok("D: a disabled submit button is not a way to submit", rs && rs.via === "none" && /disabled or hidden/.test(rs.reason), JSON.stringify(rs));
    await open("/search.html");
    const cs = await cap();
    ok("D: only the search field gets a search path; the unrelated Email field and its Subscribe form do not", cs.targets.filter((t) => t.search).length === 1 && cs.targets.find((t) => t.name === "Email").search === null);

    // -- Search: one approval fills AND submits --
    await open("/search.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    v = view();
    const searchApproval = A.getPendingApproval();
    ok("D: 'search for black Nike shoes' is ONE proposal covering fill + submit, and Approve is offered for the whole operation", approvable() && /^Search for "black Nike shoes" using the text field/.test(v.action) && /fill the search field with "black Nike shoes", then click the "Search" button/.test(v.action) && /Approve this search \(fill and submit\)/.test(approve().textContent), v.action);
    ok("D: the note names the fixed sequence and says there is no second approval between the steps", /fixed sequence with no second approval between the steps: 1\) fill the search field with "black Nike shoes"; 2\) click the "Search" button/.test(ids["approval-note"].textContent) && /does not open results or click anything else/.test(ids["approval-note"].textContent), ids["approval-note"].textContent);
    ok("D: the approval is bound to query, field, submit target and initial state", searchApproval.action === "search" && searchApproval.text === "black Nike shoes" && searchApproval.key > 0 && searchApproval.search.via === "control" && searchApproval.search.submit.key > 0 && searchApproval.search.submit.name === "Search" && searchApproval.initialValue === "" && searchApproval.documentToken.length > 0 && searchApproval.tabId === 7);
    ok("D: nothing has happened yet (no dispatch, no search request, field empty)", dispatches() === 0 && searchReqs().length === 0 && (await valueOf("[name=q]")) === "");
    ids["approve-button"].fire("click"); ids["approve-button"].fire("click"); ids["approve-button"].fire("click");
    await idle();
    ok("D: ONE approval (three rapid clicks) -> ONE dispatch -> ONE search request carrying exactly the query", dispatches() === 1 && JSON.stringify(searchReqs()) === '["black Nike shoes"]', JSON.stringify(searchReqs()) + " dispatches " + dispatches());
    let sl = await slog();
    ok("D: the page saw, in order: the typed input, the click on the Search button, the form submit - once each, no Enter key", sl.indexOf("input:q:insertText") >= 0 && sl.indexOf("input:q:insertText") < sl.indexOf("click:Search") && sl.indexOf("click:Search") < sl.indexOf("submit") && sl.filter((x) => x === "submit").length === 1 && sl.filter((x) => x.startsWith("click:")).length === 1 && !sl.some((x) => x.startsWith("key:")), sl.join(","));
    ok("D: no second approval was needed or requested between typing and submission, and none is left", A.getPendingApproval() === null && approve().hidden === true);
    ok("D: nothing else was done: no result opened, no other request; the model was asked only once (for the proposal)", requests.filter((u) => !/favicon/.test(u)).map((u) => new URL(u, "http://x").pathname).join(",") === "/results.html" && p.state.fetchCalls.length === 1, requests.join(","));
    ok("D: results are reported only because they were OBSERVED (page changed + query in its address)", /Search submitted; results observed/.test(ids["execution-status"].textContent) && /The field was filled with the query; the search was submitted by clicking its search button\. Results observed: the page changed and its address contains your query/.test(ids["execution-effect"].textContent) && /Goal verified: no/.test(ids["execution-goal"].textContent), resultText());
    ok("D: the page was captured again (the results page) and the model was not asked for a next step", /Page captured again as a\d+/.test(ids["execution-page"].textContent) && /Item 1/.test(ids["after-text"].textContent) && p.state.fetchCalls.length === 1);

    // -- Type: fills only, never submits --
    await open("/search.html"); requests.length = 0; await clearSlog(); resetCounters();
    await propose("type black Nike shoes into the search box", (c) => ({ action: "type", target_id: fieldId(c), text: "black Nike shoes" }));
    ok("D: 'type black Nike shoes into the search box' is a TYPE proposal: plain Approve, note says typing only", approvable() && /^Type "black Nike shoes" into the text field/.test(view().action) && /\(typing only\)/.test(ids["approval-note"].textContent) && approve().textContent === "Approve this one action");
    await click(approve());
    sl = await slog();
    ok("D: Type fills the field and nothing else: value set, NO submit, NO click, NO key press, NO request, page unchanged", (await valueOf("[name=q]")) === "black Nike shoes" && searchReqs().length === 0 && !sl.some((x) => x === "submit" || x.startsWith("click:") || x.startsWith("key:")) && (await evalIn("location.pathname")) === "/search.html" && dispatches() === 1, sl.join(","));
    ok("D: ...and says so, with what the new capture shows", /nothing was submitted/.test(ids["execution-effect"].textContent) && /new capture shows the field holds exactly "black Nike shoes"/.test(ids["execution-effect"].textContent), ids["execution-effect"].textContent);
    await open("/search.html"); resetCounters();
    await propose("type black Nike shoes into the search box", (c) => ({ action: "search", target_id: fieldId(c), text: "black Nike shoes" }));
    v = view();
    ok("D: if the model answers 'search' to a 'type' goal, the panel blocks it (goal does not ask to search), so Type can never become a search", v.rejected && !approvable() && v.checks.some((c) => /^Blocked by a rule: Your goal does not ask to search/.test(c)) && dispatches() === 0, v.checks.join("//"));
    ok("D: goalAsksToSearch: verbs yes, 'search box/bar/field' nouns no", A.goalAsksToSearch("search for black Nike shoes") && A.goalAsksToSearch("find red shoes") && A.goalAsksToSearch("look up the weather") && !A.goalAsksToSearch("type black Nike shoes into the search box") && !A.goalAsksToSearch("enter shoes in the search bar") && !A.goalAsksToSearch("fill the search field with shoes"));

    // -- the box already holds exactly the query: not retyped, still submitted under the same operation --
    await open("/search-prefilled.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    ok("D: the exact query already in the box: the plan says it will not be retyped", approvable() && /already holds exactly this query, so it is not retyped, then click the "Search" button/.test(view().action) && /1\) the field already holds exactly this query, so it is not retyped/.test(ids["approval-note"].textContent), view().action);
    await click(approve());
    sl = await slog();
    ok("D: exact query -> NO input event (not retyped), still submitted once with the same approval", dispatches() === 1 && !sl.some((x) => x.startsWith("input:")) && JSON.stringify(searchReqs()) === '["black Nike shoes"]' && sl.filter((x) => x === "submit").length === 1, sl.join(",") + " " + JSON.stringify(searchReqs()));
    ok("D: ...and the result says it was not retyped", /already held exactly the query, so it was not retyped/.test(ids["execution-effect"].textContent), ids["execution-effect"].textContent);
    await open("/search.html"); requests.length = 0; await clearSlog(); resetCounters();
    await evalIn("document.querySelector('[name=q]').value = 'black Nike'; 0"); // a partial query (set by the TEST)
    await proposeSearch();
    ok("D: a different query in the box is replaced, not appended (the approval was bound to the box's initial content)", approvable() && /fill the search field with "black Nike shoes"/.test(view().action) && A.getPendingApproval().initialValue === "black Nike", String(A.getPendingApproval() && A.getPendingApproval().initialValue));
    await click(approve());
    ok("D: the request carries exactly the new query (replaced, not 'black Nikeblack Nike shoes')", JSON.stringify(searchReqs()) === '["black Nike shoes"]', JSON.stringify(searchReqs()));

    // -- the form path: requestSubmit on an identified search form (native validation + site behaviour preserved) --
    await open("/search-form-only.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    ok("D: no search button: the plan says it submits via the search form (requestSubmit)", approvable() && /then submit the search form \(requestSubmit\)/.test(view().action));
    await click(approve());
    sl = await slog();
    ok("D: requestSubmit fired the form's real submit event (form.submit() would not), exactly once, with no click and no Enter key, and the request carries the query", dispatches() === 1 && sl.filter((x) => x === "submit").length === 1 && !sl.some((x) => x.startsWith("click:") || x.startsWith("key:")) && JSON.stringify(searchReqs()) === '["black Nike shoes"]', sl.join(","));
    ok("D: the form route is described honestly (a submit REQUEST; the browser's validation applies)", /by requesting submit on its search form \(the browser's own validation and the site's handling apply\)/.test(ids["execution-effect"].textContent), ids["execution-effect"].textContent);
    await open("/search-validation.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    await click(approve());
    sl = await slog();
    ok("D: the page's own validation is preserved: an invalid query is NOT forced through (no submit event, no request) and the result does NOT claim success", dispatches() === 1 && searchReqs().length === 0 && !sl.includes("submit") && (await evalIn("location.pathname")) === "/search-validation.html" && /Search submit requested; results NOT observed/.test(ids["execution-status"].textContent) && /results are not observed/.test(ids["execution-effect"].textContent), resultText());

    // -- the landmark path (no form): the associated Find control --
    await open("/search-landmark.html"); requests.length = 0; await clearSlog(); resetCounters();
    await propose(searchGoal, (c) => ({ action: "search", target_id: idOf(c, "Search the shop", "text-field"), text: "black Nike shoes" }));
    ok("D: landmark search without a form is offered via its Find button", approvable() && /click the "Find" button/.test(view().action));
    await click(approve());
    ok("D: ...and one click on Find submits the query", JSON.stringify(searchReqs()) === '["black Nike shoes"]' && (await slog()).includes("click:Find"));

    // -- unsupported submission: blocked before approval is offered --
    for (const [path2, re] of [["/search-ambiguous.html", /several submit buttons and none is clearly the search button/], ["/search-plain.html", /not identified as a search form/], ["/search-settings.html", /not identified as a search form/], ["/search-disabled.html", /disabled or hidden/]]) {
      await open(path2); resetCounters(); requests.length = 0;
      await propose(searchGoal, (c) => ({ action: "search", target_id: [...c.records.values()].find((r) => r.search).id, text: "black Nike shoes" }));
      v = view();
      ok(`D: ${path2}: search is blocked BEFORE approval (no safe submission path), nothing dispatched`, v.rejected && !approvable() && v.checks.some((c) => /^Blocked by a rule: .*no supported way to submit it/.test(c) && re.test(c)) && dispatches() === 0 && searchReqs().length === 0, v.checks.join("//"));
    }
    await open("/search-ambiguous.html");
    await propose("type black Nike shoes into the search box", (c) => ({ action: "type", target_id: fieldId(c), text: "black Nike shoes" }));
    ok("D: ...but plain Type into that same field is still offered (it only fills)", approvable());

    // -- stop on an unexpected change: partial execution is reported honestly --
    await open("/search-mutating.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    await click(approve());
    sl = await slog();
    ok("D: the page rewrote the value after filling (expected new state not reached) -> STOPS before submitting: no submit event, no request", dispatches() === 1 && searchReqs().length === 0 && !sl.includes("submit") && !sl.some((x) => x.startsWith("click:")), sl.join(","));
    ok("D: ...and reports exactly what was done: field filled, search NOT submitted", /Partly executed: the field was filled with "black Nike shoes", but the search was NOT submitted/.test(ids["execution-status"].textContent) && /does not hold exactly the query/.test(ids["execution-status"].textContent) && /The field was changed and left as it is/.test(ids["execution-effect"].textContent) && /holds something different/.test(ids["execution-effect"].textContent) && !/Search submitted/.test(ids.status.textContent), resultText());
    ok("D: ...the field was left as the page made it (nothing improvised: no retry, no retyping)", (await valueOf("[name=q]")) === "BLACK NIKE SHOES" && (await slog()).filter((x) => x.startsWith("input:")).length >= 1);
    await open("/search-disabling.html"); requests.length = 0; await clearSlog(); resetCounters();
    await proposeSearch();
    await click(approve());
    sl = await slog();
    ok("D: the submit button got disabled by the page after typing -> STOPS: filled but not submitted, reported as partial", dispatches() === 1 && searchReqs().length === 0 && !sl.includes("submit") && /Partly executed: the field was filled with "black Nike shoes", but the search was NOT submitted/.test(ids["execution-status"].textContent) && /changed after the field was filled/.test(ids["execution-status"].textContent) && /holds exactly "black Nike shoes"/.test(ids["execution-effect"].textContent), resultText());

    // -- stale or changed state between the proposal and the approval --
    const searchStale = [
      ["the search box content changed (someone typed)", "document.querySelector('[name=q]').value = 'something else'; 0", /Not done: the search box content changed since the proposal/],
      ["the search button was renamed", "document.querySelector('header button').textContent = 'Go'; 0", /Not done: (the page changed since the proposal|the way to submit the search changed|the control changed)/],
      ["the search button was removed", "document.querySelector('header button').remove(); 0", /Not done: (the page changed since the proposal|the way to submit the search changed)/],
      ["the search button was disabled", "document.querySelector('header button').disabled = true; 0", /Not done: (the page changed since the proposal|the way to submit the search changed)/],
      ["the search field was replaced by an identical clone", "(() => { const o = document.querySelector('[name=q]'); o.replaceWith(o.cloneNode(true)); })(); 0", /Not done: the control is missing or hidden/],
      ["another control was added", "document.body.appendChild(Object.assign(document.createElement('button'), {textContent: 'Newcomer'})); 0", /Not done: the page changed since the proposal/],
      ["the page address changed", "history.pushState({}, '', '/elsewhere'); 0", /Not done: the page address changed/],
      ["the page was reloaded", "location.reload(); 0", /Not done: the page was reloaded or replaced/],
    ];
    for (const [label, js, re] of searchStale) {
      await open("/search.html"); requests.length = 0; await clearSlog(); resetCounters();
      await proposeSearch();
      const was = approvable();
      await evalIn(js);
      if (/reloaded/.test(label)) await sleep(400);
      resetCounters(); await clearSlog();
      await click(approve());
      sl = await slog();
      ok(`D: ${label} -> refused ("${ids["execution-status"].textContent.slice(0, 55)}"), nothing typed, nothing submitted`, was && re.test(ids["execution-status"].textContent) && dispatches() === 0 && searchReqs().length === 0 && !sl.some((x) => x.startsWith("input:") || x === "submit") && A.getPendingApproval() === null, ids["execution-status"].textContent);
    }
    await open("/search.html"); resetCounters();
    await proposeSearch();
    p.handlers.activated({ tabId: 99 });
    ok("D: switching tabs drops a search approval immediately", A.getPendingApproval() === null && approve().hidden === true);
    await open("/search.html"); requests.length = 0;
    await proposeSearch();
    resetCounters(); // the proposal's own captures must not count towards the gate
    let reachedS; const reachedSP = new Promise((r) => (reachedS = r));
    let releaseS; const waitSP = new Promise((r) => (releaseS = r));
    gate = { func: "captureActionTargets", nth: 1, reached: reachedS, wait: waitSP };
    ids["approve-button"].fire("click");
    await reachedSP;
    ids["stop-button"].fire("click");
    releaseS(); gate = null; await idle();
    ok("D: Stop before dispatch cancels the whole search: nothing typed, nothing submitted", dispatches() === 0 && searchReqs().length === 0 && /Cancelled\. Nothing was dispatched/.test(ids["execution-status"].textContent) && (await valueOf("[name=q]")) === "");
    await open("/search.html"); requests.length = 0;
    await proposeSearch();
    resetCounters();
    let reachedT; const reachedTP = new Promise((r) => (reachedT = r));
    let releaseT; const waitTP = new Promise((r) => (releaseT = r));
    gate = { func: "performApprovedAction", nth: 1, reached: reachedT, wait: waitTP };
    ids["approve-button"].fire("click");
    await reachedTP;
    ids["stop-button"].fire("click");
    ok("D: Stop after the dispatch began says it cannot undo", /already dispatched\. Stop cannot undo it/.test(ids.status.textContent), ids.status.textContent);
    releaseT(); gate = null; await idle();
    ok("D: ...the search still ran exactly once and is reported (not as cancelled)", JSON.stringify(searchReqs()) === '["black Nike shoes"]' && !/Cancelled/.test(ids["execution-status"].textContent));

    // -- the executor itself, called directly: it re-checks the approved state --
    await open("/search.html"); await clearSlog(); requests.length = 0;
    let cd = await cap();
    const fld = cd.targets.find((t) => t.name === "Search");
    const swSpec = (extra = {}) => ({ action: "search", token: cd.documentToken, key: fld.key, signature: fld.signature, kind: fld.kind, text: "black Nike shoes", direction: "", step: 0, initialValue: "", submit: { via: fld.search.via, key: fld.search.submit.key, signature: fld.search.submit.signature, formKey: fld.search.formKey }, ...extra });
    r = await exe(swSpec({ initialValue: "stale" }));
    ok("A: executor: a different initial state than the approved one -> refused before touching anything", r.ok === false && r.code === "field-changed" && searchReqs().length === 0 && (await valueOf("[name=q]")) === "", JSON.stringify(r));
    r = await exe(swSpec({ submit: { via: "control", key: fld.search.submit.key, signature: "00000000", formKey: fld.search.formKey } }));
    ok("A: executor: a different submit target than the approved one -> refused before touching anything", r.ok === false && r.code === "changed" && (await valueOf("[name=q]")) === "", JSON.stringify(r));
    r = await exe(swSpec({ submit: { via: "form", key: 0, signature: "", formKey: fld.search.formKey } }));
    ok("A: executor: a different submission route (form instead of control) -> refused", r.ok === false && (await valueOf("[name=q]")) === "", JSON.stringify(r));
    r = await exe(swSpec({ text: "line\nbreak" }));
    ok("A: executor: a query with a line break -> refused", r.ok === false && r.code === "bad-request");
    r = await exe(swSpec());
    ok("A: executor: the approved search runs: fill, then submit (one call)", r.ok === true && r.steps.length === 2 && r.steps[0].step === "fill" && r.steps[0].done === true && r.steps[1].step === "submit" && r.steps[1].via === "control", JSON.stringify(r));
    await sleep(300);
    ok("A: ...and one request reached the server", JSON.stringify(searchReqs()) === '["black Nike shoes"]');

    // =========================================================================================
    // E. Consequential-looking controls: an explicit confirmation, not a rejection
    // =========================================================================================
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    await click(approve());
    resetCounters(); await clearLog();
    await propose("delete the element I added", (c) => ({ action: "click", target_id: nthDelete(c, 1).id }));
    v = view();
    ok("E: 'Delete' is no longer rejected by name: valid format, with a warning that it needs an explicit confirmation", !v.rejected && /Valid target\/action format/.test(v.banner) && v.warnings.some((w) => /needs an explicit confirmation before it can run: Its name contains "Delete"/.test(w)) && !v.checks.some((c) => /Blocked by a rule/.test(c)), v.banner + " | " + v.warnings.join("//"));
    ok("E: the button is 'Review and confirm...', not an immediate approval", approvable() && approve().textContent === "Review and confirm..." && /needs a separate explicit confirmation/.test(ids["approval-note"].textContent));
    await click(approve());
    ok("E: pressing it only OPENS the confirmation: nothing ran, the control is still there", ids["confirm-box"].hidden === false && ids["approve-button"].hidden === true && dispatches() === 0 && (await evalIn("document.querySelectorAll('.added-manually').length")) === 1);
    ok("E: the confirmation shows the operation, why you are asked, what is KNOWN and what is UNKNOWN", /^Operation: Click the button "Delete"/.test(ids["confirm-operation"].textContent) && /Its name contains "Delete", so Cloudy asks you to confirm separately/.test(ids["confirm-reason"].textContent) && /^Known: this is a button on the page\. What the page does when it is used is not known to Cloudy\./.test(ids["confirm-known"].textContent) && /^Unknown: the real effect\. Cloudy does not infer it from the name/.test(ids["confirm-unknown"].textContent), [ids["confirm-operation"], ids["confirm-reason"], ids["confirm-known"], ids["confirm-unknown"]].map((e) => e.textContent).join(" | "));
    ok("E: it does not invent a consequence from the name (no 'will delete/remove/destroy')", !/will (delete|remove|destroy|erase)|permanent|cannot be undone/i.test([ids["confirm-known"], ids["confirm-unknown"], ids["confirm-reason"]].map((e) => e.textContent).join(" ")));
    ids["cancel-confirm-button"].fire("click");
    ok("E: Cancel closes the confirmation and runs nothing; the approval is still pending", ids["confirm-box"].hidden === true && approve().hidden === false && A.getPendingApproval() !== null && dispatches() === 0);
    await click(approve());
    ids["confirm-button"].fire("click"); ids["confirm-button"].fire("click"); ids["confirm-button"].fire("click");
    await idle();
    ok("E: Confirm (clicked three times) runs the ONE click once; the Delete button is gone", dispatches() === 1 && (await evalIn("document.querySelectorAll('.added-manually').length")) === 0 && /Action dispatched/.test(ids["execution-status"].textContent) && ids["confirm-box"].hidden === true && A.getPendingApproval() === null, resultText());
    await A.confirmProposal(); await idle();
    ok("E: confirming again does nothing", dispatches() === 1);
    // stale between the confirmation being shown and confirmed
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    await click(approve());
    await propose("delete the element I added", (c) => ({ action: "click", target_id: nthDelete(c, 1).id }));
    await click(approve());
    await evalIn("document.querySelector('.added-manually').textContent = 'Delete all'; 0");
    resetCounters();
    await click(ids["confirm-button"]);
    ok("E: the control changed while the confirmation was open -> refused after Confirm, nothing clicked", /Not done: (the control changed|the page changed since the proposal)/.test(ids["execution-status"].textContent) && dispatches() === 0 && (await evalIn("document.querySelectorAll('.added-manually').length")) === 1, ids["execution-status"].textContent);
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    await click(approve());
    await propose("delete the element I added", (c) => ({ action: "click", target_id: nthDelete(c, 1).id }));
    await click(approve());
    p.handlers.activated({ tabId: 99 });
    ok("E: switching tabs while the confirmation is open closes it and drops the approval", ids["confirm-box"].hidden === true && A.getPendingApproval() === null);
    resetCounters();
    await A.confirmProposal(); await idle();
    ok("E: and a late Confirm click then does nothing", dispatches() === 0);

    // ---- source-level guarantees ----
    const sp = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
    const spCode = sp.replace(/\/\/.*$/gm, "");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    ok("C: no new permissions (manifest unchanged: scripting/activeTab/sidePanel; same hosts)", JSON.stringify(manifest.permissions) === '["sidePanel","activeTab","scripting"]' && JSON.stringify(manifest.host_permissions) === '["http://localhost:11434/*","https://*/*","http://*/*"]' && !manifest.content_scripts && !manifest.optional_permissions);
    ok("C: only executor.js can click/type/scroll; the panel never does", !/\.click\(|\.focus\(|execCommand|insertText|scrollBy\(|scrollTo\(|dispatchEvent|chrome\.debugger|chrome\.tabs\.(update|create|remove|reload)/.test(sp.replace(/\/\/.*$/gm, "")));
    ok("C: the only caller of the executor is the approval path, and the executor gets no model text", (spCode.match(/performApprovedAction/g) || []).length === 1 && /func: performApprovedAction/.test(spCode));
    ok("C: after an action the panel never calls the model by itself (the only fetch is inside runRequest)", (spCode.match(/\bfetch\(/g) || []).length === 1);
    ok("C: no automatic chain: runApproved/approveProposal never call suggestNextAction or runRequest", !/runApproved[\s\S]*?(suggestNextAction|runRequest)\(/.test(sp.slice(sp.indexOf("async function runApproved"), sp.indexOf("// Separate mode: never runs for Send or Ask"))));

    console.log(results.join("\n"));
    const failed = results.filter((x) => x.startsWith("FAIL")).length;
    console.log(`exec tests: ${results.length - failed} passed, ${failed} failed`);
    await cleanup();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.log(results.join("\n"));
    console.error("exec test crashed:", e && e.stack ? e.stack : e);
    await cleanup();
    process.exit(2);
  }
})();

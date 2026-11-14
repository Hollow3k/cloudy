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

const LOGGER = `<script>window.__log=[];
document.addEventListener('click',e=>__log.push('click:'+((e.target.textContent||e.target.name||e.target.localName)+'').trim()),true);
document.addEventListener('input',e=>__log.push('input:'+(e.target.name||e.target.id)+':'+e.inputType));
document.addEventListener('keydown',e=>__log.push('key:'+e.key));
document.addEventListener('submit',e=>{__log.push('submit');e.preventDefault();});</script>`;
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${LOGGER}</body></html>`;
const PAGES = {
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
  const server = http.createServer((req, res) => {
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
    ok("A: executor.js never reads a value, text or placeholder of a field, never presses Enter and never submits", !/\.value\b|\.defaultValue|\.textContent|\.innerText|\.placeholder|requestSubmit|\.submit\(|KeyboardEvent|keydown|"Enter"/.test(exeSrc));

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
    ok("B: typing result does NOT claim the value was verified, and says why", /Cloudy never reads field values, so it cannot confirm what the field now holds/.test(ids["execution-effect"].textContent) && !/verified (the|that)|confirmed that/i.test(ids["execution-effect"].textContent));
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
    // Delete stays blocked
    resetCounters();
    await propose("click Delete", (c) => ({ action: "click", target_id: nthDelete(c, 1).id }));
    v = view();
    ok("B: Delete stays blocked: rejected by a rule, no Approve, no dispatch", v.rejected && /blocked by Cloudy's safety rules/.test(v.banner) && !approvable() && v.checks.some((c) => /^Blocked by a rule: .*consequential action/.test(c)) && dispatches() === 0, v.banner);
    ok("B: a blocked reply is not described as a format problem", !/Invalid format/.test(v.checks.join("|")));

    // ---- new proposals / tab or document changes invalidate approval ----
    await open("/addremove.html");
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    ok("B: eligible before invalidation", approvable());
    await propose("what is on this page", () => ({ action: "ask_user", question: "Which control do you mean?" }));
    ok("B: a NEW proposal replaces the approval (an ask_user reply has nothing to approve)", A.getPendingApproval() === null && approve().hidden === true);
    await propose("click Add Element", (c) => ({ action: "click", target_id: idOf(c, "Add Element", "button") }));
    p.handlers.activated({ tabId: 99 });
    ok("B: switching tabs drops the approval", A.getPendingApproval() === null && approve().hidden === true);
    resetCounters(); await A.approveProposal(); await idle();
    ok("B: ...and calling approve anyway dispatches nothing", dispatches() === 0 && calls.length === 0);
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
    ok("B: scroll down at the bottom: valid format but NOT offered (impossible), with the reason", !approvable() && /Not offered for approval: this scroll is not possible: the page is already at the bottom/.test(v.warnings.join("|")));
    await evalIn("window.scrollTo(0, 0); 0");
    await propose("scroll up", () => ({ action: "scroll", direction: "up" }));
    v = view();
    ok("B: scroll up at the top: not offered", !approvable() && /already at the top/.test(v.warnings.join("|")));
    await open("/short.html");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    ok("B: a page that does not scroll: not offered", !approvable() && /does not scroll/.test(view().warnings.join("|")));
    await open("/tall.html");
    await propose("scroll down", () => ({ action: "scroll", direction: "down" }));
    ok("B: eligible before the page moves", approvable());
    await evalIn("window.scrollTo(0, document.documentElement.scrollHeight); 0");
    resetCounters();
    await click(approve());
    ok("B: the page reached the bottom before approval -> refused at dispatch time, no dispatch", /Not done: this scroll is not possible/.test(ids["execution-status"].textContent) && /already at the bottom/.test(ids["execution-status"].textContent) && dispatches() === 0, ids["execution-status"].textContent);
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

// Renders the REAL sidepanel.html (real CSS, real sidepanel.js/actions.js/targets.js)
// in headless Chrome at side-panel width and saves screenshots. The chrome.*
// API and the model are STUBS (a recorded capture and a canned reply), so this
// shows how the UI looks and flows in a real browser engine. It is not the
// installed extension and not the model.
//   node tests/render-panel.js
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTH = Number(process.env.PANEL_WIDTH || 380);

const store = JSON.parse(fs.readFileSync(path.join(out, "act_store.json"), "utf8"));
store.snapshot.url = "https://site.test/page"; store.targets.url = "https://site.test/page";

// Scenarios: each is a goal, the canned model reply (built from the live IDs), and optional page changes.
const SCENARIOS = {
  valid_type: { goal: "search for red running shoes", reply: `(c) => ({ action: "type", target_id: byName(c, "Search products"), text: "red running shoes", direction: "", question: "", reason: "", rationale: "The search box is where a product search goes." })` },
  valid_click_dup: { goal: "open the shop", reply: `(c) => ({ action: "click", target_id: byName(c, "Shop"), text: "", direction: "", question: "", reason: "", rationale: "The Shop link leads to the products." })` },
  rejected_button: { goal: "type shoes into the cart button", reply: `(c) => ({ action: "type", target_id: byName(c, "Add to cart"), text: "shoes", direction: "", question: "", reason: "", rationale: "Trying to type into a button." })` },
  rejected_buy: { goal: "buy these shoes", reply: `(c) => ({ action: "click", target_id: byName(c, "Buy now"), text: "", direction: "", question: "", reason: "", rationale: "The Buy now button completes the goal." })` },
  stale: { goal: "search for shoes", reply: `(c) => ({ action: "click", target_id: byName(c, "Add to cart"), text: "", direction: "", question: "", reason: "", rationale: "Add the item." })`, mutateAfterCapture: true },
  malformed: { goal: "do something", reply: `() => "Sure! I will click the big green button now."` },
  cannot: { goal: "log in with my password", reply: `(c) => ({ action: "cannot", target_id: "", text: "", direction: "", question: "", reason: "Logging in needs a password field, which is not supported yet.", rationale: "Password entry is out of scope." })` },
};

async function main() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(out, "profile_r" + port);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--allow-file-access-from-files", "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let ws;
  const shots = [];
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch (_) {}
      await sleep(250);
    }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalIn = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result.result.value; };
    await send("Page.enable");

    // Stubs installed BEFORE the page's own scripts run.
    const stub = `
      window.__STORE = ${JSON.stringify(store)};
      window.__CALLS = [];
      window.__mutated = false;
      const real = { snapshot: window.__STORE.snapshot, targets: window.__STORE.targets };
      window.chrome = {
        tabs: {
          query: async () => [{ id: 7, url: "https://site.test/page?x=1" }],
          onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
        },
        scripting: { executeScript: async (o) => {
          window.__CALLS.push(o.func.name);
          if (o.func.name === "captureActionTargets") {
            const t = JSON.parse(JSON.stringify(real.targets));
            if (window.__mutated && window.__CALLS.filter((n) => n === "captureActionTargets").length >= 2) { t.targets[14].name = "Add to wishlist"; t.fingerprint = "deadbeef"; t.targets[14].signature = "0badc0de"; }
            return [{ result: t }];
          }
          if (o.func.name === "performApprovedAction") return [{ result: { ok: true, action: o.args[0].action, kind: o.args[0].kind, method: "insertText" } }];
          return [{ result: real.snapshot }];
        } },
      };
      window.byName = (c, n) => { for (const r of c.records.values()) if (r.name === n) return r.id; return ""; };
      window.__reply = null;
      window.fetch = async (url, opts) => {
        window.__lastBody = JSON.parse(opts.body);
        const r = window.__reply();
        return { ok: true, json: async () => ({ response: typeof r === "string" ? r : JSON.stringify(r), prompt_eval_count: 1120, total_duration: 3.4e9 }) };
      };`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: stub });
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(root, "sidepanel.html").replace(/\\/g, "/") });
    for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("document.readyState")) === "complete" && (await evalIn("typeof suggestNextAction")) === "function") break; }

    const shot = async (name) => {
      const full = await evalIn("document.documentElement.scrollHeight");
      await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: Math.min(full + 10, 4000), deviceScaleFactor: 2, mobile: false });
      await sleep(150);
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
      shots.push(name);
    };

    await shot("ui_idle");
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      // Fresh page state per scenario.
      await send("Page.navigate", { url: "file:///" + path.join(root, "sidepanel.html").replace(/\\/g, "/") });
      for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("document.readyState")) === "complete" && (await evalIn("typeof suggestNextAction")) === "function") break; }
      await evalIn(`window.__reply = () => (${sc.reply})(actionContext); window.__mutated = ${sc.mutateAfterCapture ? "true" : "false"}; 0`);
      await evalIn(`document.getElementById("prompt-input").value = ${JSON.stringify(sc.goal)}; document.getElementById("suggest-button").click(); 0`);
      for (let i = 0; i < 60; i++) { await sleep(150); if ((await evalIn(`document.getElementById("stop-button").disabled`)) === true && (await evalIn(`document.getElementById("status").textContent`)) !== "Ready.") break; }
      await sleep(250);
      const state = await evalIn(`({ status: document.getElementById("status").textContent, calls: window.__CALLS.join(","), hasExecute: /execute|run now|apply/i.test(document.body.innerText), overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
      fs.writeFileSync(path.join(out, "ui_" + name + ".json"), JSON.stringify(state));
      await shot("ui_" + name);
      console.log(name + ": " + state.status.slice(0, 110) + " | overflowX=" + state.overflowX);
    }
    // Approve one valid proposal (the page-side action is a stub here) and show the result.
    await send("Page.navigate", { url: "file:///" + path.join(root, "sidepanel.html").replace(/\\/g, "/") });
    for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("typeof suggestNextAction")) === "function") break; }
    await evalIn(`window.__reply = () => (${SCENARIOS.valid_type.reply})(actionContext); document.getElementById("prompt-input").value = "search for red running shoes"; document.getElementById("suggest-button").click(); 0`);
    await sleep(900);
    const approveShown = await evalIn(`!document.getElementById("approve-button").hidden`);
    await evalIn(`document.getElementById("approve-button").click(); 0`);
    await sleep(1500);
    const approved = await evalIn(`({ calls: window.__CALLS.join(","), status: document.getElementById("status").textContent, goal: document.getElementById("execution-goal").textContent, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
    await shot("ui_approved_type");
    console.log("approved_type: approve shown=" + approveShown + " | " + approved.status.slice(0, 100) + " | " + approved.goal.slice(0, 60) + " | overflowX=" + approved.overflowX);

    // Open the inspection panels once.
    await evalIn(`window.__reply = () => (${SCENARIOS.valid_type.reply})(actionContext); 0`);
    await send("Page.navigate", { url: "file:///" + path.join(root, "sidepanel.html").replace(/\\/g, "/") });
    for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("typeof suggestNextAction")) === "function") break; }
    await evalIn(`window.__reply = () => (${SCENARIOS.valid_type.reply})(actionContext); document.getElementById("prompt-input").value = "search for red running shoes"; document.getElementById("suggest-button").click(); 0`);
    await sleep(900);
    await evalIn(`document.getElementById("targets-details").open = true; 0`);
    await shot("ui_valid_type_targets_open");
  } finally {
    try { ws && ws.close(); } catch (_) {}
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
  fs.writeFileSync(path.join(out, "render_done.txt"), shots.join(","));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

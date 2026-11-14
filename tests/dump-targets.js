// Opens each action fixture in headless Chrome and runs the REAL capture.js and
// targets.js against the rendered DOM (DevTools protocol). Also applies each
// mutation to the dynamic page at the SAME address and captures again, and
// reloads the page to capture a new document at the same address.
// Not the installed extension: the page functions run in the page's main world
// here, in an isolated world there. They read the same DOM.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The limits the panel uses (read from the source so they cannot drift).
const TARGET_LIMITS = new Function(fs.readFileSync(path.join(root, "actions.js"), "utf8").replace(/^const /gm, "var ") + "\nreturn TARGET_LIMITS;")();
const SNAP_LIMITS = { textChars: 2400, labelMax: 60, headingMax: 200, titleMax: 150, urlMax: 200, maxHeadings: 40, maxLinks: 60, maxNavLinks: 60, maxControls: 40, maxUrlChars: 400, minRegionChars: 150, measureCap: 40000, fallbackMinText: 200, outsideH1Max: 2, navScanCap: 300 };
const capSrc = fs.readFileSync(path.join(root, "capture.js"), "utf8");
const tgtSrc = fs.readFileSync(process.env.TARGETS_SRC || path.join(root, "targets.js"), "utf8");

async function main() {
  const names = fs.readFileSync(path.join(out, "act_names.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  const mutations = JSON.parse(fs.readFileSync(path.join(out, "act_mutations.json"), "utf8"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(out, "profile_t" + port);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "--window-size=1280,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let ws;
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
    const evalIn = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    const open = async (name) => {
      await send("Page.navigate", { url: "file:///" + path.join(out, name + ".html").replace(/\\/g, "/") });
      for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("document.readyState")) === "complete" && (await evalIn("location.href")).startsWith("file:")) break; }
      await sleep(150);
    };
    const captureTargets = async () => JSON.parse(await evalIn(`(function(){ ${tgtSrc}\n return JSON.stringify(captureActionTargets(${JSON.stringify(TARGET_LIMITS)})); })()`));
    const captureSnapshot = async () => JSON.parse(await evalIn(`(function(){ ${capSrc}\n return JSON.stringify(capturePageSnapshot(${JSON.stringify(SNAP_LIMITS)})); })()`));

    for (const name of names) {
      await open(name);
      const snapshot = await captureSnapshot();
      const tg = await captureTargets();
      fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify({ snapshot, targets: tg }));
      console.log("captured " + name + " (" + tg.targets.length + " targets)");
    }
    for (const [mname, script] of Object.entries(mutations)) {
      await open("act_dynamic");
      const before = await captureTargets();
      if (script) await evalIn(`(function(){ ${script} })(); 0`);
      await sleep(120);
      const after = await captureTargets();
      fs.writeFileSync(path.join(out, "dyn_" + mname + ".json"), JSON.stringify({ before, after }));
      console.log("mutation " + mname + ": fingerprints " + (before.fingerprint === after.fingerprint ? "same" : "differ") + ", token " + (before.documentToken === after.documentToken ? "same" : "differ"));
    }
    // Same address, brand-new document.
    await open("act_dynamic");
    const first = await captureTargets();
    await open("act_dynamic");
    const second = await captureTargets();
    fs.writeFileSync(path.join(out, "dyn_reload.json"), JSON.stringify({ before: first, after: second }));
    console.log("reload: token " + (first.documentToken === second.documentToken ? "same" : "differ") + ", fingerprint " + (first.fingerprint === second.fingerprint ? "same" : "differ"));
  } finally {
    try { ws && ws.close(); } catch (_) {}
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

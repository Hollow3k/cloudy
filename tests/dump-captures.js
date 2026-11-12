// Opens each fixture in ONE headless Chrome, runs the real capture.js against the
// RENDERED DOM through the DevTools protocol, and saves the result as JSON in
// tests/.out/. (Not the installed extension: the page script runs in the page's
// main world here, the extension runs it in an isolated world. The DOM it reads
// is the same.) Optional: pass a URL and a name to capture a live page instead.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// The same limits sidepanel.js passes to capturePageSnapshot.
const LIMITS = { textChars: 2400, labelMax: 60, headingMax: 200, titleMax: 150, urlMax: 200, maxHeadings: 40, maxLinks: 60, maxNavLinks: 60, maxControls: 40, maxUrlChars: 400, minRegionChars: 150, measureCap: 40000, fallbackMinText: 200, outsideH1Max: 2, navScanCap: 300 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const jobs = process.argv[2]
    ? [{ name: process.argv[3] || "live", url: process.argv[2], settle: 4000 }]
    : fs.readFileSync(path.join(out, "names.txt"), "utf8").split(/\r?\n/).filter(Boolean).map((name) => ({
        name,
        url: "file:///" + path.join(out, name + ".html").replace(/\\/g, "/"),
        settle: 150,
      }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(out, "profile_" + port);
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
    const evalIn = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
    await send("Page.enable");
    // CAPTURE_SRC lets a test run a modified copy of capture.js (used to prove
    // that the regression tests fail when a fix is removed).
    const src = fs.readFileSync(process.env.CAPTURE_SRC || path.join(root, "capture.js"), "utf8");
    for (const job of jobs) {
      await send("Page.navigate", { url: job.url });
      for (let i = 0; i < 80; i++) { await sleep(150); if ((await evalIn("document.readyState")) === "complete" && (await evalIn("location.href")) !== "about:blank") break; }
      await sleep(job.settle);
      const json = await evalIn(`(function(){ ${src}\n return JSON.stringify(capturePageSnapshot(${JSON.stringify(LIMITS)})); })()`);
      fs.writeFileSync(path.join(out, "snap_" + job.name + ".json"), json || "NOJSON");
      console.log((json ? "captured " : "FAILED   ") + job.name);
    }
  } finally {
    try { ws && ws.close(); } catch (_) {}
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

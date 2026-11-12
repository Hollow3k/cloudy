// Live-model checks. Builds the request exactly as the panel does (sidepanel.js)
// from a saved capture in tests/.out/, sends it to the configured local Ollama
// model, and scores each reply with objective checks. Skips if Ollama is not
// running. A small model is not deterministic, so each question runs RUNS times
// and the summary shows how many passed; this reports a rate, it does not prove
// compliance.
//   node tests/model.test.js [captureName] [runsPerQuestion]
// Default capture: ref_contents_main (a local fixture shaped like a reference
// page). To use a real page: node tests/dump-captures.js <url> <name>, then
// node tests/model.test.js <name>.
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");
const capture = process.argv[2] || "ref_contents_main";
const RUNS = Number(process.argv[3] || 3);

class FakeEl { constructor() { this.children = []; this.classList = { toggle() {} }; } set textContent(v) { this._t = v; } get textContent() { return this._t || ""; } appendChild(c) { return c; } addEventListener() {} setAttribute() {} }
global.document = { getElementById: () => new FakeEl(), createElement: () => new FakeEl() };
eval(fs.readFileSync(path.join(root, "sidepanel.js"), "utf8").replace(/^const /gm, "var ").replace(/^let /gm, "var "));

function build(question) {
  const raw = JSON.parse(fs.readFileSync(path.join(out, `snap_${capture}.json`), "utf8"));
  raw.url = "https://site.test/page"; // the fixture is a file: URL; the panel only cares that it is consistent
  const ev = buildEvidence(normalizeSnapshot(raw), "s1", SNAPSHOT_BUDGET_CHARS);
  return { ev, body: { model: MODEL, prompt: buildPagePrompt(question, ev.snapshotText), system: PAGE_SYSTEM_PROMPT, format: REPLY_SCHEMA, stream: false, think: false } };
}

// ---- objective checks -------------------------------------------------------
function headingsReport(p, ev) {
  const heads = [...ev.records.values()].filter((r) => r.type === "heading");
  const sent = new Map(heads.filter((r) => r.sent).map((r) => [r.text, r.level]));
  const omitted = new Set(heads.filter((r) => !r.sent).map((r) => r.text));
  const quoted = (p.answer.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
  const stripped = p.answer.replace(/\bs\d+:[HLNCT]\d*\s*\|?\s*/g, "");
  let wrongLevels = 0;
  for (const m of stripped.matchAll(/\bh([1-6])\b[^"\n]{0,14}"([^"]+)"/gi)) if (sent.has(m[2]) && sent.get(m[2]) !== Number(m[1])) wrongLevels++;
  let wrongIds = 0;
  for (const m of p.answer.matchAll(/(s\d+:H\d+)\s*\|\s*h([1-6])[^"\n]{0,6}"([^"]+)"/g)) {
    const rec = ev.records.get(m[1]);
    if (!rec || rec.text !== m[3] || rec.level !== Number(m[2])) wrongIds++;
  }
  const exact = quoted.filter((q) => sent.has(q)).length;
  const citedTexts = new Set(p.citations.map((c) => ev.records.get(c)).filter((r) => r && r.type === "heading").map((r) => r.text));
  const listed = new Set(quoted.filter((q) => sent.has(q)));
  const citationsMatch = citedTexts.size === listed.size && [...citedTexts].every((t) => listed.has(t));
  return { listed: quoted.length, exact, notExact: quoted.length - exact, namedOmitted: quoted.filter((q) => omitted.has(q)).length, wrongLevels, wrongIds, citationsMatch };
}
const urlsIn = (a) => (a.match(/https?:\/\/[^\s"')]+/g) || []).map((u) => u.replace(/[.,;]+$/, ""));
const FIRST = (() => { const raw = JSON.parse(fs.readFileSync(path.join(out, `snap_${capture}.json`), "utf8")); return raw.headings[0] ? raw.headings[0].text : ""; })();

const QUESTIONS = [
  { id: "at-most-3-headings", text: "List at most three actual headings from this snapshot, with their levels.",
    pass: (p, ev) => { const r = headingsReport(p, ev); return p.status === "answered" && r.listed >= 1 && r.listed <= 3 && r.notExact === 0 && r.wrongLevels === 0 && r.wrongIds === 0 && r.citationsMatch && p.answer.includes(FIRST); } },
  { id: "first-2-headings-exact", text: "List the first two headings exactly as written, with their levels.",
    pass: (p, ev) => { const r = headingsReport(p, ev); return r.listed === 2 && r.notExact === 0 && r.wrongLevels === 0 && r.wrongIds === 0 && r.citationsMatch && p.answer.includes(FIRST); } },
  { id: "exactly-1-nav-link", text: "Give me exactly one navigation link from this snapshot: its label and destination.",
    pass: (p, ev) => { const navs = [...ev.records.values()].filter((r) => r.type === "nav" && r.sent); const u = urlsIn(p.answer); return u.length === 1 && navs.some((r) => r.href === u[0]) && p.citations.filter((c) => /:N\d+$/.test(c)).length === 1; } },
  { id: "exactly-2-content-links", text: "List exactly two links from the page content with their destinations.",
    pass: (p, ev) => { const links = [...ev.records.values()].filter((r) => r.type === "link" && r.sent); const u = urlsIn(p.answer); return u.length === 2 && new Set(u).size === 2 && u.every((x) => links.some((r) => r.href === x)); } },
  { id: "exactly-30-headings-only-fewer-exist", text: "List exactly 30 headings with their levels.",
    pass: (p, ev) => { const r = headingsReport(p, ev); return r.listed <= [...ev.records.values()].filter((x) => x.type === "heading" && x.sent).length && r.notExact === 0 && r.namedOmitted === 0; } },
  { id: "quote-first-heading", text: "What is the first heading in the snapshot, and what is its level? Quote it exactly.",
    pass: (p) => p.answer.includes(FIRST) && /\b(h1|level 1|1)\b/i.test(p.answer) },
  { id: "abstain-missing-evidence", text: "What is the price of the product on this page?",
    pass: (p) => p.status === "insufficient_evidence" && p.citations.length === 0 },
];

(async () => {
  try { await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(3000) }); }
  catch (_) { console.log("model tests skipped: Ollama is not reachable at localhost:11434"); process.exit(0); }
  console.log(`model ${MODEL}, capture ${capture}, ${RUNS} run(s) per question`);
  const lines = []; let allPass = 0; let total = 0;
  for (const q of QUESTIONS) {
    let pass = 0; const notes = [];
    for (let i = 0; i < RUNS; i++) {
      const { ev, body } = build(q.text);
      try {
        const r = await fetch(OLLAMA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
        const data = await r.json();
        const p = parseStructuredReply(data.response);
        if (!p.ok) { notes.push("rejected: " + p.reason); continue; }
        if (q.pass(p, ev)) pass++; else notes.push(`FAILED reply: ${p.status} | ${p.answer.replace(/\s+/g, " ").slice(0, 160)}`);
      } catch (e) { notes.push("request failed: " + e.message); }
    }
    total += RUNS; allPass += pass;
    lines.push(`${pass === RUNS ? "PASS" : "FAIL"}  ${q.id}: ${pass}/${RUNS}${notes.length ? "\n        " + notes.slice(0, 2).join("\n        ") : ""}`);
    console.log(lines[lines.length - 1]);
  }
  console.log(`\nmodel tests: ${allPass}/${total} runs passed`);
  fs.writeFileSync(path.join(out, `model_${capture}.txt`), lines.join("\n") + `\n\n${allPass}/${total} runs passed`);
  process.exit(0);
})();

// Live-model checks of the WHOLE path: the real sidepanel.js (in the fake browser
// of tests/fake-panel.js) sends the request to the configured local Ollama model,
// parses the reply, checks every ID, and draws the result. The checks judge what is
// DRAWN (answer text, listed entries, source cards, warnings, status), not the raw
// JSON. Skips if Ollama is not running. A small model varies from run to run, so
// each question runs RUNS times and the summary shows a rate; it does not prove
// compliance, and no check here is a semantic guarantee.
//   node tests/model.test.js [captureName] [runsPerQuestion]       (ONLY=id1,id2 limits questions)
// Default capture: ref_contents_main (a local fixture). For a real page:
//   node tests/dump-captures.js <url> <name>   then   node tests/model.test.js <name> 5
const fs = require("fs");
const path = require("path");
const { load } = require("./fake-panel.js");
const out = path.join(__dirname, ".out");
const capture = process.argv[2] || "ref_contents_main";
const RUNS = Number(process.argv[3] || 3);

const sentOfType = (ctx, type) => [...ctx.records.values()].filter((r) => r.sent && r.type === type);
const levelByText = (ctx) => new Map(sentOfType(ctx, "heading").map((h) => [h.text, h.level]));
// hN ... "exact text" pairs written in the model's own prose that contradict the capture.
function proseLevelErrors(reply, ctx) {
  const lvl = levelByText(ctx);
  const stripped = reply.replace(/\bs\d+:[HLNCT]\d*\s*\|?\s*/g, "");
  let wrong = 0;
  for (const m of stripped.matchAll(/\bh([1-6])\b[^"\n]{0,14}"([^"]+)"/gi)) if (lvl.has(m[2]) && lvl.get(m[2]) !== Number(m[1])) wrong++;
  return wrong;
}
const proseRetypes = (reply, ctx) => (reply.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)).filter((q) => levelByText(ctx).has(q)).length;

const QUESTIONS = [
  { id: "at-most-3-headings", text: "List at most three actual headings from this snapshot, with their levels.",
    // Strict: the DRAWN entries are right, AND the model's own lead-in does not contradict the captured levels.
    check: (v, ctx) => v.listed.length >= 1 && v.listed.length <= 3 && v.warnings.length === 0 && proseLevelErrors(v.reply, ctx) === 0 },
  { id: "first-2-headings-exact", text: "List the first two headings exactly as written, with their levels.",
    check: (v, ctx) => { const first = sentOfType(ctx, "heading").slice(0, 2).map((h) => h.id); return v.listed.length === 2 && v.listed.every((t, i) => t.startsWith(first[i] + " ")) && v.warnings.length === 0 && proseLevelErrors(v.reply, ctx) === 0; } },
  { id: "exactly-1-nav-link", text: "Give me exactly one navigation link from this snapshot: its label and destination.",
    check: (v) => v.listed.length === 1 && /Navigation link \(/.test(v.listed[0]) && /https?:\/\//.test(v.listed[0]) && v.warnings.length === 0 },
  { id: "exactly-2-content-links", text: "List exactly two links from the page content with their destinations.",
    check: (v) => v.listed.length === 2 && v.listed.every((t) => / Link: /.test(t) && /https?:\/\//.test(t)) && new Set(v.listed).size === 2 && v.warnings.length === 0 },
  { id: "exactly-30-headings-fewer-exist", text: "List exactly 30 headings with their levels.",
    check: (v, ctx) => v.listed.length <= sentOfType(ctx, "heading").length && v.warnings.length === 0 },
  { id: "quote-first-heading", text: "What is the first heading in the snapshot, and what is its level? Quote it exactly.",
    check: (v, ctx) => { const h1 = sentOfType(ctx, "heading")[0]; return (v.listed.some((t) => t.startsWith(h1.id + " ")) || v.reply.includes(h1.text)) && proseLevelErrors(v.reply, ctx) === 0 && v.warnings.length === 0; } },
  { id: "summary", text: "Summarize this page in a few sentences.",
    // Proxy checks, NOT a semantic guarantee: answered; nothing listed; 1-5 distinct IDs named; none from site
    // navigation; every ID valid; and the PANEL (not the model) states partial coverage when the capture is partial.
    check: (v, ctx, r) => v.reply.length > 40 && v.listed.length === 0 && r.named.size >= 1 && r.named.size <= 5 && ![...r.named].some((id) => ctx.records.get(id) && ctx.records.get(id).type === "nav") && v.warnings.length === 0 && (!ctx.truncated || /Coverage is partial:/.test(v.status)) },
  { id: "abstain-missing-evidence", text: "What is the price of the product on this page?",
    check: (v, ctx, r) => r.status === "insufficient_evidence" && v.warnings.length === 0 && v.listed.length === 0 },
];

(async () => {
  try { await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(3000) }); }
  catch (_) { console.log("model tests skipped: Ollama is not reachable at localhost:11434"); process.exit(0); }
  const p = load({ live: true });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  console.log(`model ${p.api.MODEL}, capture ${capture}, ${RUNS} run(s) per question`);
  const lines = []; let allPass = 0; let total = 0;
  const extra = { retypedRuns: 0, listRuns: 0, citationCounts: [], summaryMentionsPartial: 0, wholeLineEntries: 0 };
  for (const q of QUESTIONS.filter((x) => !only || only.includes(x.id))) {
    let pass = 0; const notes = [];
    for (let i = 0; i < RUNS; i++) {
      p.useCapture(capture);
      const real = p.state.fetchImpl; const r = { named: new Set(), status: "", entries: [] };
      p.state.fetchImpl = async (url, opts) => { // remember what the model named; the path under test is unchanged
        const res = await real(url, opts);
        try { const data = await res.clone().json(); const parsed = p.api.parseStructuredReply(data.response); if (parsed.ok) { r.status = parsed.status; r.entries = parsed.entries; r.named = new Set([...parsed.entries, ...parsed.citations].map((x) => String(x).trim())); } } catch (_) {}
        return res;
      };
      try {
        await p.ask(q.text);
        const v = p.view(); const ctx = p.api.getPageContext();
        if (!ctx) { notes.push("no capture context"); continue; }
        if (v.isError) { notes.push("ERROR status: " + v.status.slice(0, 120)); continue; }
        if (r.entries.some((e) => typeof e === "string" && /\s\|\s/.test(e))) extra.wholeLineEntries++;
        if (q.id.startsWith("at-most") || q.id.startsWith("first-2")) { extra.listRuns++; if (proseRetypes(v.reply, ctx) > 0) extra.retypedRuns++; }
        if (q.id === "summary") { extra.citationCounts.push(r.named.size); if (/\b(partial|part of|excerpt|cut off|only (the )?captured|not (the )?(whole|entire|full))\b/i.test(v.reply)) extra.summaryMentionsPartial++; }
        if (q.check(v, ctx, r)) pass++;
        else notes.push(`FAILED: status=${r.status} listed=${v.listed.length} cards=${v.cards.length} warnings=${v.warnings.length} named=${r.named.size} proseLevelErrors=${proseLevelErrors(v.reply, ctx)} | ${v.reply.replace(/\s+/g, " ").slice(0, 150)}`);
      } catch (e) { notes.push("run failed: " + e.message); }
      p.state.fetchImpl = real;
    }
    total += RUNS; allPass += pass;
    lines.push(`${pass === RUNS ? "PASS" : "FAIL"}  ${q.id}: ${pass}/${RUNS}${notes.length ? "\n        " + notes.slice(0, 2).join("\n        ") : ""}`);
    console.log(lines[lines.length - 1]);
  }
  const summary = `\nmodel tests: ${allPass}/${total} runs passed.\n` +
    `  list answers whose lead-in prose retyped a heading anyway: ${extra.retypedRuns}/${extra.listRuns}\n` +
    `  runs where "entries" held whole lines instead of bare IDs: ${extra.wholeLineEntries}\n` +
    `  distinct IDs named per summary: [${extra.citationCounts.join(", ")}]; summaries whose own text mentions partial coverage: ${extra.summaryMentionsPartial}/${extra.citationCounts.length}`;
  console.log(summary);
  fs.writeFileSync(path.join(out, `model_${capture}.txt`), lines.join("\n") + summary);
  process.exit(0);
})();

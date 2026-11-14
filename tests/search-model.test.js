// Live-model checks for the Search operation: does the local model choose "search" for search goals,
// and "type" (never "search") for goals that only ask to type? The real panel code runs in the fake
// browser of tests/fake-panel.js against fixtures rendered in headless Chrome. Scored on the model's
// RAW reply, separately from what the panel's validator then did with it. Nothing is executed.
//   node tests/search-model.test.js [runsPerScenario]     (ONLY=id1,id2 limits scenarios)
const fs = require("fs");
const path = require("path");
const { load } = require("./fake-panel.js");
const out = path.join(__dirname, ".out");
const RUNS = Number(process.argv[2] || 4);

const rec = (ctx, raw) => (raw && raw.target_id ? ctx.records.get(raw.target_id.trim()) || null : null);
const isSearchField = (ctx, raw) => { const r = rec(ctx, raw); return !!r && r.kind === "text-field" && !!r.search && r.search.field === true; };
const queryOk = (raw, q) => String(raw.text || "").trim().toLowerCase() === q.toLowerCase();

const prefilled = (fixture, value) => (p) => {
  const d = p.actionFixture(fixture);
  const f = d.targets.targets.find((t) => t.search);
  f.value = value; f.valueLen = value.length;
  p.useAction(d);
};
const SCENARIOS = [
  { id: "search-store", fixture: "act_store", goal: "search for black Nike shoes", expect: "search, on the search field, text = the query", good: (raw, ctx) => raw.action === "search" && isSearchField(ctx, raw) && queryOk(raw, "black Nike shoes") },
  { id: "search-plain-engine", fixture: "act_search", goal: "search for cheap flights to Lisbon", expect: "search on the Search field", good: (raw, ctx) => raw.action === "search" && isSearchField(ctx, raw) && queryOk(raw, "cheap flights to Lisbon") },
  { id: "find-store", fixture: "act_store", goal: "find red running shoes", expect: "search (find = search verb)", good: (raw, ctx) => raw.action === "search" && isSearchField(ctx, raw) && queryOk(raw, "red running shoes") },
  { id: "type-only-store", fixture: "act_store", goal: "type black Nike shoes into the search box", expect: "type (NOT search): it only fills", good: (raw, ctx) => raw.action === "type" && isSearchField(ctx, raw) && queryOk(raw, "black Nike shoes"), severe: (raw) => raw.action === "search" },
  { id: "type-only-engine", fixture: "act_search", goal: "enter cheap flights to Lisbon in the search field", expect: "type (NOT search)", good: (raw, ctx) => raw.action === "type" && isSearchField(ctx, raw) && queryOk(raw, "cheap flights to Lisbon"), severe: (raw) => raw.action === "search" },
  { id: "search-exact-prefilled", fixture: "act_store", prepare: prefilled("act_store", "black Nike shoes"), goal: "search for black Nike shoes", expect: "search (the box already shows the query; it is not retyped by the panel)", good: (raw, ctx) => raw.action === "search" && isSearchField(ctx, raw) && queryOk(raw, "black Nike shoes") },
];

(async () => {
  try { await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(3000) }); }
  catch (_) { console.log("search model tests skipped: Ollama is not reachable at localhost:11434"); process.exit(0); }
  const p = load({ live: true });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  console.log(`model ${p.api.MODEL}, ${RUNS} run(s) per scenario`);
  const lines = []; let runs = 0; let good = 0; let severe = 0; let valid = 0;
  for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
    const row = { good: 0, severe: 0, outcomes: {}, notes: [] };
    for (let i = 0; i < RUNS; i++) {
      if (sc.prepare) sc.prepare(p); else p.useAction(sc.fixture);
      const real = p.state.fetchImpl; let rawText = "";
      p.state.fetchImpl = async (u, o) => { const r = await real(u, o); try { rawText = (await r.clone().json()).response; } catch (_) {} return r; };
      await p.suggest(sc.goal);
      const v = p.actionView(); const ctx = p.api.getActionContext();
      p.state.fetchImpl = real;
      let raw = null; try { raw = JSON.parse(rawText); } catch (_) {}
      const outcome = v.hidden ? "none" : /could not be used as a proposal/.test(v.banner) ? "malformed" : /REJECTED/.test(v.banner) ? "rejected" : /Valid target\/action format\.$/.test(v.banner) ? "valid" : "valid-but-stale";
      runs++; row.outcomes[outcome] = (row.outcomes[outcome] || 0) + 1;
      if (!raw || !ctx) { row.notes.push(`unusable reply (${outcome})`); continue; }
      const ok = !!sc.good(raw, ctx); const sv = !!(sc.severe && sc.severe(raw, ctx));
      if (ok) { row.good++; good++; }
      if (sv) { row.severe++; severe++; }
      if (outcome === "valid" && ok) valid++;
      if (!ok) row.notes.push(`WRONG: ${raw.action} ${raw.target_id} ${raw.text ? JSON.stringify(raw.text) : ""} | ${String(raw.rationale || raw.question || raw.reason).slice(0, 110)} | panel: ${outcome}`.replace(/\s+/g, " "));
    }
    lines.push(`${row.good === RUNS ? "PASS" : "FAIL"}  ${sc.id}: right ${row.good}/${RUNS}; panel outcome ${JSON.stringify(row.outcomes)}${row.severe ? `; WRONG-KIND (search for a type-only goal) ${row.severe}` : ""}   [expected: ${sc.expect}]${row.notes.length ? "\n        " + row.notes.slice(0, 3).join("\n        ") : ""}`);
    console.log(lines[lines.length - 1]);
  }
  const summary = `\nTOTAL ${runs} runs: right ${good}, right AND accepted by the panel ${valid}, search-for-a-type-goal ${severe}.`;
  console.log(summary);
  fs.writeFileSync(path.join(out, process.env.RESULT_FILE || "search_model_result.txt"), lines.join("\n") + summary + "\nDONE");
  process.exit(0);
})();

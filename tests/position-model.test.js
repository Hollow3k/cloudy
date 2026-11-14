// Live-model checks for positional goals ("bottom left", "the button" ...). The real
// panel code runs in the fake browser of tests/fake-panel.js against fixtures rendered
// in headless Chrome (so the rectangles are real getBoundingClientRect values), and the
// local Ollama model chooses. Scored on the model's RAW reply (which control it chose),
// separately from what the panel's validator then did with it: "Delete" buttons are
// refused as consequential-looking by the validator, whatever position was chosen.
// Nothing is executed. Use ACTIONS_SRC=<file> to run an older actions.js for comparison.
//   node tests/position-model.test.js [runsPerScenario]     (ONLY=id1,id2 limits scenarios)
const fs = require("fs");
const path = require("path");
const { load } = require("./fake-panel.js");
const out = path.join(__dirname, ".out");
const RUNS = Number(process.argv[2] || 4);

const nth = (ctx, name, k) => { const l = [...ctx.records.values()].filter((r) => r.name === name); return l[k - 1] || null; };
const chose = (raw, ctx) => (raw && raw.target_id ? ctx.records.get(raw.target_id.trim()) || null : null);
const clicksDelete = (k) => (raw, ctx) => raw.action === "click" && chose(raw, ctx) === nth(ctx, "Delete", k);
const asks = (raw) => raw.action === "ask_user";

const SCENARIOS = [
  { id: "one-row-bottom-left", fixture: "act_addremove", goal: "click the bottom left button", expect: "click the FIRST Delete (leftmost button of the lowest row)", good: clicksDelete(1) },
  { id: "one-row-unspecified", fixture: "act_addremove", goal: "click the button", expect: "ask_user (several buttons fit; no scroll, no guess)", good: asks, severe: (raw) => raw.action === "scroll" },
  { id: "one-row-add", fixture: "act_addremove", goal: "click the Add Element button", expect: "click Add Element (a named control still works)", good: (raw, ctx) => raw.action === "click" && chose(raw, ctx) && chose(raw, ctx).name === "Add Element" },
  { id: "two-rows-bottom-left", fixture: "act_addremove_rows", goal: "click the bottom left Delete button", expect: "click the 4th Delete (leftmost of the lower row)", good: clicksDelete(4) },
  { id: "two-rows-bottom-right", fixture: "act_addremove_rows", goal: "click the bottom right Delete button", expect: "click the 5th Delete (rightmost of the lower row)", good: clicksDelete(5) },
  { id: "two-rows-top-left", fixture: "act_addremove_rows", goal: "click the top left Delete button", expect: "click the 1st Delete", good: clicksDelete(1) },
  { id: "two-rows-top-right", fixture: "act_addremove_rows", goal: "click the top right Delete button", expect: "click the 3rd Delete", good: clicksDelete(3) },
  { id: "two-rows-unspecified", fixture: "act_addremove_rows", goal: "click the Delete button", expect: "ask_user (five identical Delete buttons)", good: asks, severe: (raw) => raw.action === "scroll" },
  { id: "two-rows-no-scroll-invented", fixture: "act_addremove_rows", goal: "click the button in the middle", expect: "ask_user or cannot, never scroll", good: (raw) => raw.action === "ask_user" || raw.action === "cannot", severe: (raw) => raw.action === "scroll" },
];

(async () => {
  try { await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(3000) }); }
  catch (_) { console.log("position model tests skipped: Ollama is not reachable at localhost:11434"); process.exit(0); }
  const p = load({ live: true });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  console.log(`model ${p.api.MODEL}, ${RUNS} run(s) per scenario, actions.js: ${process.env.ACTIONS_SRC || "current"}`);
  const lines = []; let runs = 0; let good = 0; let severe = 0;
  for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
    const row = { good: 0, severe: 0, outcomes: {}, notes: [] };
    for (let i = 0; i < RUNS; i++) {
      p.useAction(sc.fixture);
      const real = p.state.fetchImpl; let rawText = "";
      p.state.fetchImpl = async (u, o) => { const r = await real(u, o); try { rawText = (await r.clone().json()).response; } catch (_) {} return r; };
      await p.suggest(sc.goal);
      const v = p.actionView(); const ctx = p.api.getActionContext();
      p.state.fetchImpl = real;
      let raw = null; try { raw = JSON.parse(rawText); } catch (_) {}
      const outcome = v.hidden ? "none" : /could not be used as a proposal/.test(v.banner) ? "malformed" : /REJECTED/.test(v.banner) ? "rejected" : "valid";
      runs++; row.outcomes[outcome] = (row.outcomes[outcome] || 0) + 1;
      if (!raw || !ctx) { row.notes.push(`unusable reply (${outcome}): ${(v.warnings[0] || v.status).slice(0, 100)}`); continue; }
      const ok = !!sc.good(raw, ctx); const sv = !!(sc.severe && sc.severe(raw, ctx));
      if (ok) { row.good++; good++; }
      if (sv) { row.severe++; severe++; }
      if (!ok) { const t = chose(raw, ctx); row.notes.push(`WRONG: ${raw.action} ${raw.target_id}${t ? ` (${t.name} #${t.dupIndex} at [${t.centre}])` : ""} ${raw.question || raw.reason ? "- " + (raw.question || raw.reason).slice(0, 80) : ""} | rationale: ${raw.rationale.slice(0, 140)}`.replace(/\s+/g, " ")); }
    }
    lines.push(`${row.good === RUNS ? "PASS" : "FAIL"}  ${sc.id}: right ${row.good}/${RUNS}; panel outcome ${JSON.stringify(row.outcomes)}${row.severe ? `; SEVERE ${row.severe}` : ""}   [expected: ${sc.expect}]${row.notes.length ? "\n        " + row.notes.slice(0, 3).join("\n        ") : ""}`);
    console.log(lines[lines.length - 1]);
  }
  const summary = `\nTOTAL ${runs} runs: right step ${good}, severe ${severe}.`;
  console.log(summary);
  fs.writeFileSync(path.join(out, process.env.RESULT_FILE || "position_model_result.txt"), lines.join("\n") + summary + "\nDONE");
  process.exit(0);
})();

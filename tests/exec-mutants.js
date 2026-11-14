// Mutation check for tests/exec.test.js: break one safeguard at a time in a COPY of the
// source (tests/.out/mut_*.js) and confirm the suite notices (exit code != 0).
//   node tests/exec-mutants.js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
const out = path.join(__dirname, ".out");
const sp = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
const ex = fs.readFileSync(path.join(root, "executor.js"), "utf8");

const once = (src, a, b) => {
  if (src.split(a).length !== 2) throw new Error("mutant anchor not found exactly once: " + a.slice(0, 70));
  return src.replace(a, () => b);
};
const MUTANTS = [
  // (The busy/active-execution guard is a second line of defence, so both are removed here.)
  ["panel: approval consumed AFTER the awaits and no busy guard (double click would run twice)", "SIDEPANEL_SRC", () => {
    let s = once(sp, "  approval.consumed = true;\n  pendingApproval = null;\n", "");
    s = once(s, "if (!approval || approval.consumed || inFlight || activeExecution) return;", "if (!approval) return;");
    return once(s, "  let result;\n  try {\n    result = await runApproved(approval, exec);", "  let result;\n  try {\n    result = await runApproved(approval, exec);\n    approval.consumed = true; pendingApproval = null;");
  }],
  ["panel: target found by signature instead of identity key (would retarget a clone)", "SIDEPANEL_SRC", () => once(sp, "norm.targets.find((t) => t.key === a.key)", "norm.targets.find((t) => t.signature === a.signature)")],
  ["panel: page-wide fingerprint check removed", "SIDEPANEL_SRC", () => once(sp, "if (norm.fingerprint !== a.fingerprint || norm.targets.length !== a.controlCount) {", "if (false) {")],
  ["panel: scroll feasibility not rechecked at dispatch time", "SIDEPANEL_SRC", () => once(sp, "if (!plan.ok) return refusal(\"Not done: this scroll is not possible.\"", "if (false) return refusal(\"Not done: this scroll is not possible.\"")],
  // (There are three cancellation checks, the last one right before the dispatch; all are removed.)
  ["panel: Stop does not cancel before dispatch", "SIDEPANEL_SRC", () => sp.replaceAll("if (exec.cancelled) return cancelledResult(exec);", "")],
  ["panel: document token not compared", "SIDEPANEL_SRC", () => once(sp, "if (norm.documentToken !== a.documentToken) return refusal", "if (false) return refusal")],
  ["panel: rules not applied again to the fresh control", "SIDEPANEL_SRC", () => once(sp, "if (check.kind !== \"valid\") {", "if (false) {")],
  ["panel: typing result claims verification", "SIDEPANEL_SRC", () => once(sp, "return \"The approved text was sent to the field. Cloudy never reads field values, so it cannot confirm what the field now holds.\";", "return \"The text was typed and verified in the field.\";")],
  ["executor: signature not compared", "EXECUTOR_SRC", () => once(ex, "cur.signature !== spec.signature || cur.kind !== spec.kind", "false")],
  ["executor: credential-looking check removed", "EXECUTOR_SRC", () => once(ex, "if (cur.sensitive) return fail(", "if (false) return fail(")],
  ["executor: scroll does not check remaining distance", "EXECUTOR_SRC", () => once(ex, "if (!(remaining >= 1)) {", "if (false) {")],
  ["executor: offscreen controls are acted on", "EXECUTOR_SRC", () => once(ex, "if (cur.viewport !== \"in-view\" && cur.viewport !== \"partly-in-view\") {", "if (false) {")],
  ["executor: javascript: links are clicked", "EXECUTOR_SRC", () => once(ex, "if (el.localName === \"a\" && /^\\s*javascript:/i", "if (false && /^\\s*javascript:/i")],
];

const only = process.env.ONLY ? Number(process.env.ONLY) : null;
let missed = 0;
MUTANTS.forEach(([name, envName, make], i) => {
  if (only !== null && i !== only) return;
  const file = path.join(out, `mut_${i}.js`);
  fs.writeFileSync(file, make());
  const r = spawnSync(process.execPath, [path.join(__dirname, "exec.test.js")], { env: { ...process.env, [envName]: file }, encoding: "utf8", timeout: 170000 });
  const lines = (r.stdout || "").split("\n");
  const failed = lines.filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6, 90));
  const caught = r.status !== 0;
  if (!caught) missed++;
  console.log(`${caught ? "CAUGHT " : "MISSED "} ${name}  (exit ${r.status}; ${failed.length} failing check(s)${failed[0] ? ": " + failed[0] : ""})`);
});
console.log(missed === 0 ? "all mutants caught" : `${missed} mutant(s) NOT caught`);

// Mutation check: break one safeguard at a time in a COPY of the source (tests/.out/mut_*.js) and
// confirm the suite that should notice it does (exit code != 0). Default suite: tests/exec.test.js.
//   node tests/exec-mutants.js            (ONLY=<index> runs one, FROM=<index> runs that one and later ones)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
const out = path.join(__dirname, ".out");
const sp = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
const ex = fs.readFileSync(path.join(root, "executor.js"), "utf8");
const ac = fs.readFileSync(path.join(root, "actions.js"), "utf8");

const once = (src, a, b) => {
  if (src.split(a).length !== 2) throw new Error("mutant anchor not found exactly once: " + a.slice(0, 70));
  return src.replace(a, () => b);
};
const MUTANTS = [
  // (The busy/active-execution guard is a second line of defence, so both are removed here.)
  ["panel: approval consumed AFTER the awaits and no busy guard (double click would run twice)", "SIDEPANEL_SRC", () => {
    let s = once(sp, "  approval.consumed = true;\n  pendingApproval = null;\n", "");
    s = once(s, "if (!approval || approval.consumed || inFlight || activeExecution || activeTask) return;", "if (!approval) return;");
    return once(s, "  let result;\n  try {\n    result = await runApproved(approval, exec);", "  let result;\n  try {\n    result = await runApproved(approval, exec);\n    approval.consumed = true; pendingApproval = null;");
  }],
  ["panel: target found by signature instead of identity key (would retarget a clone)", "SIDEPANEL_SRC", () => once(sp, "norm.targets.find((t) => t.key === a.key)", "norm.targets.find((t) => t.signature === a.signature)")],
  ["panel: page-wide fingerprint check removed", "SIDEPANEL_SRC", () => once(sp, "if (!a.loose && (norm.fingerprint !== a.fingerprint || norm.targets.length !== a.controlCount)) {", "if (false) {")],
  ["panel: scroll feasibility not rechecked at dispatch time", "SIDEPANEL_SRC", () => once(sp, "if (!plan.ok) return refusal(\"Not done: this scroll is not possible.\"", "if (false) return refusal(\"Not done: this scroll is not possible.\"")],
  // (There are three cancellation checks, the last one right before the dispatch; all are removed.)
  ["panel: Stop does not cancel before dispatch", "SIDEPANEL_SRC", () => sp.replaceAll("if (exec.cancelled) return cancelledResult(exec);", "")],
  ["panel: document token not compared", "SIDEPANEL_SRC", () => once(sp, "if (norm.documentToken !== a.documentToken) return refusal", "if (false) return refusal")],
  ["panel: rules not applied again to the fresh control", "SIDEPANEL_SRC", () => once(sp, "if (check.kind !== \"valid\") {", "if (false) {")],
  ["panel: typing result claims verification instead of reporting the new capture", "SIDEPANEL_SRC", () => once(sp, "nothing was submitted. ${observeFieldValue(a, after)}", "nothing was submitted. The text was typed and verified in the field.")],
  ["executor: signature not compared", "EXECUTOR_SRC", () => once(ex, ": c.signature === spec.signature && c.kind === spec.kind;", ": c.kind === spec.kind;")],
  ["executor: credential-looking check removed", "EXECUTOR_SRC", () => once(ex, "if (cur.sensitive) return fail(", "if (false) return fail(")],
  ["executor: scroll does not check remaining distance", "EXECUTOR_SRC", () => once(ex, "if (!(remaining >= 1)) {", "if (false) {")],
  ["executor: offscreen controls are acted on", "EXECUTOR_SRC", () => once(ex, "if (cur.viewport !== \"in-view\" && cur.viewport !== \"partly-in-view\") {", "if (false) {")],
  ["executor: javascript: links are clicked", "EXECUTOR_SRC", () => once(ex, "if (el.localName === \"a\" && /^\\s*javascript:/i", "if (false && /^\\s*javascript:/i")],
  // ---- Search, confirmation, scroll validity (added with the Search operation) ----
  ["executor: the search box's initial content is not compared", "EXECUTOR_SRC", () => once(ex, 'if (typeof spec.initialValue !== "string" || before !== spec.initialValue) {', "if (false) {")],
  ["executor: the field is not checked against the expected NEW state after filling", "EXECUTOR_SRC", () => once(ex, "if (el.value !== spec.text) {", "if (false) {")],
  ["executor: the page is not looked at again after filling", "EXECUTOR_SRC", () => once(ex, "if (now === null || !sameTarget(now) || !samePath(now.search)) {", "if (false) {")],
  ["executor: form.submit() instead of requestSubmit() (skips validation and the submit event)", "EXECUTOR_SRC", () => once(ex, "else second.form.requestSubmit();", "else second.form.submit();")],
  ["executor: always retypes, even when the box already holds exactly the query", "EXECUTOR_SRC", () => once(ex, "if (before === spec.text) {", "if (false) {")],
  ["panel: a consequential control runs straight from Approve (no confirmation step)", "SIDEPANEL_SRC", () => once(sp, "if (approval.confirm && !approval.confirmed) {", "if (false) {")],
  ["panel: the search box's initial content is not compared before dispatch", "SIDEPANEL_SRC", () => once(sp, "if (current.value !== a.initialValue || current.valueLen !== a.initialValueLen) {", "if (false) {")],
  ["actions: a search reply is accepted even when the goal only asks to type", "ACTIONS_SRC", () => once(ac, "if (!goalAsksToSearch(goal)) block(", "if (false) block(")],
  ["actions: a consequential-looking name needs no confirmation", "ACTIONS_SRC", () => once(ac, 'if (p.action === "click" && !reasons.length) confirm = consequenceInfo(record);', "confirm = null;")],
  ["actions: an impossible scroll is accepted as valid", "ACTIONS_SRC", () => once(ac, "if (!plan.ok) block(`This scroll is not possible:", "if (false) block(`This scroll is not possible:")],
  // ---- automatic capture and truncation (tests/operations.test.js) ----
  ["actions: search controls are not pinned, so the size limit can cut them", "ACTIONS_SRC", () => once(ac, "pinned.has(r.key) && r.key > 0 ? -1 :", "false ? -1 :"), "operations.test.js"],
  ["panel: a tab switch does not end the old approval", "SIDEPANEL_SRC", () => once(sp, '    dropApproval();\n    if (actionContext) invalidateProposal("You switched tabs.");\n', ""), "operations.test.js"],
  ["panel: a late capture is not discarded", "SIDEPANEL_SRC", () => {
    let m = once(sp, "    if (!autoEnabled || mine !== autoSeq) return; // an event arrived while reading: this one is late\n", "");
    return once(m, 'if (!autoEnabled || mine !== autoSeq || !now || now.id !== tab.id || stripUrl(now.url || "") !== stripUrl(tab.url)) return;', "if (!now) return;");
  }, "operations.test.js"],
  ["panel: closing the panel does not stop automatic capture", "SIDEPANEL_SRC", () => once(sp, 'window.addEventListener("pagehide", () => {', 'window.addEventListener("pagehide", () => { return;'), "operations.test.js"],
  ["panel: events from inactive tabs trigger a capture", "SIDEPANEL_SRC", () => once(sp, "&& !(tabInfo && tabInfo.active === false)", ""), "operations.test.js"],
  ["panel: automatic capture runs while a request is in flight", "SIDEPANEL_SRC", () => once(sp, "  if (inFlight || activeTask) {\n    autoPending = true; // do not interleave with a model request or an approved action\n    return;\n  }\n", ""), "operations.test.js"],
  ["actions: a value is kept for a flagged (secret) field", "ACTIONS_SRC", () => once(ac, "if (textish && !sensitive) {", "if (textish) {"), "targets.test.js"],
  // ---- the task loop (added with Start) ----
  ["task: Stop/late replies are not checked (cancel checks removed)", "SIDEPANEL_SRC", () => sp.replaceAll("if (task.cancelled) return cancelled();", "")],
  ["task: 'done' is believed without observed evidence", "SIDEPANEL_SRC", () => once(sp, "if (searching ? task.resultsObserved : task.evidence.length > 0) {", "if (true) {")],
  ["task: a Type-only goal does not stop after the verified text", "SIDEPANEL_SRC", () => once(sp, 'if (approval.action === "type" && isTypeOnlyGoal(task.goal) && fieldHolds(approval, res.after)) {', "if (false) {")],
  ["task: the no-progress limit is raised to 3", "SIDEPANEL_SRC", () => once(sp, "const NO_PROGRESS_LIMIT = 2;", "const NO_PROGRESS_LIMIT = 3;")],
  ["task: a repeated step that changed nothing is run again", "SIDEPANEL_SRC", () => once(sp, "if (task.noChange.has(key)) {", "if (false) {")],
  ["task: the consequential confirmation pause is skipped", "SIDEPANEL_SRC", () => once(sp, "    if (approval.confirm) {\n      // The existing pause", "    if (false) {\n      // The existing pause")],
  ["task: switching tabs does not end the task", "SIDEPANEL_SRC", () => once(sp, 'if (activeTask && (activeTask.tabId === null || tabId !== activeTask.tabId)) cancelTask("you switched tabs");', "")],
  ["task: any changed state counts as progress (no 'seen before' check)", "SIDEPANEL_SRC", () => once(sp, "const progress = !task.sigs.has(sigAfter);", "const progress = true;")],
  // ---- multi-step fixes: waiting for an answer, recovery vs no progress, loose freshness, search discovery ----
  ["task: after an answer the page/tab is not re-checked (it would act on another page)", "SIDEPANEL_SRC", () => once(sp, "const changed = await checkSamePageAfterWait(task);", 'const changed = "";')],
  ["task: the document token is not compared after the wait", "SIDEPANEL_SRC", () => once(sp, "if (norm.documentToken !== task.waitDoc.documentToken) return", "if (false) return")],
  ["task: ask_user ends the task instead of waiting", "SIDEPANEL_SRC", () => once(sp, "const answer = await waitForAnswer(task, p.question);", 'return stop("the model needs you");')],
  ["task: Stop does not end a wait for an answer", "SIDEPANEL_SRC", () => once(sp, "  resolveTaskAnswer(task, null); // also ends a wait for the person's answer\n", "")],
  ["task: the person's answers are not given to the model", "SIDEPANEL_SRC", () => once(sp, "await suggestOnce(task.goal, taskHistory(task), taskAnswers(task));", "await suggestOnce(task.goal, taskHistory(task), []);")],
  ["task: a rejected/not-run round counts as no progress (the old behaviour)", "SIDEPANEL_SRC", () => once(sp, "    task.recoveries++;\n    return task.recoveries >= RECOVERY_LIMIT;", "    task.noProgress++;\n    return task.noProgress >= NO_PROGRESS_LIMIT;")],
  ["task: permission-style questions always go to the person", "SIDEPANEL_SRC", () => once(sp, "if (isRoutineQuestion(p.question) && task.bounces < PERMISSION_BOUNCE_LIMIT) {", "if (false) {")],
  ["task: the recovery limit is raised to 30", "SIDEPANEL_SRC", () => once(sp, "const RECOVERY_LIMIT = 3;", "const RECOVERY_LIMIT = 30;")],
  ["panel: in a task the whole-page check is used (the YouTube-style staleness)", "SIDEPANEL_SRC", () => once(sp, "loose: !!activeTask };", "loose: false };")],
  ["panel: in a task a renamed/removed control is not refused (identity/state not compared)", "SIDEPANEL_SRC", () => once(sp, "const unchanged = a.loose ? sameControl(current, a) : current.signature === a.signature;", "const unchanged = true;")],
  ["actions: a reason over 300 characters is rejected again", "ACTIONS_SRC", () => once(ac, "const ACTION_FIELD_MAX = { target_id: 40, text: 200 };", "const ACTION_FIELD_MAX = { target_id: 40, text: 200, rationale: 300 };")],
];

const only = process.env.ONLY ? Number(process.env.ONLY) : null;
const from = process.env.FROM ? Number(process.env.FROM) : 0;
let missed = 0;
MUTANTS.forEach(([name, envName, make, testFile], i) => {
  if ((only !== null && i !== only) || i < from) return;
  const file = path.join(out, `mut_${i}.js`);
  fs.writeFileSync(file, make());
  if (process.env.DRY) { console.log(`built    ${name}`); return; } // only check that every mutation still applies
  const r = spawnSync(process.execPath, [path.join(__dirname, testFile || "exec.test.js")], { env: { ...process.env, [envName]: file }, encoding: "utf8", timeout: 170000 });
  const lines = (r.stdout || "").split("\n");
  const failed = lines.filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6, 90));
  const caught = r.status !== 0;
  if (!caught) missed++;
  console.log(`${caught ? "CAUGHT " : "MISSED "} ${name}  (exit ${r.status}; ${failed.length} failing check(s)${failed[0] ? ": " + failed[0] : ""})`);
});
console.log(missed === 0 ? "all mutants caught" : `${missed} mutant(s) NOT caught`);

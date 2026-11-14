// Operations that need no real browser: automatic capture of the active page, dummy secrets staying
// out of the model request, the UI and the logs, ordinary form state, truncation-proof search
// controls, scroll validity and the confirmation text. The real panel code runs in the fake browser
// of tests/fake-panel.js against fixtures rendered in headless Chrome (make-action-fixtures.js ->
// dump-targets.js). No model is called. Not the installed extension.
const path = require("path");
const { load } = require("./fake-panel.js");
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 300) : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture everything written to the console (a secret must never reach a log).
const consoleLines = [];
for (const m of ["log", "info", "warn", "error", "debug"]) console[m] = (...a) => consoleLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const print = (...a) => process.stdout.write(a.join(" ") + "\n");

const act = (over) => ({ rationale: "r", action: "click", target_id: "", text: "", direction: "", question: "", reason: "", ...over });
const reply = (obj) => ({ ok: true, json: async () => ({ response: JSON.stringify(obj), prompt_eval_count: 1, total_duration: 1 }) });
const waitIdle = async (p) => { for (let i = 0; i < 500 && p.api.getInFlight(); i++) await sleep(10); };
const allUiText = (p) => Object.values(p.ids).map((e) => e.textContent).join("\n");

(async () => {
  // =============================================================================================
  // 1. Automatic capture of the ACTIVE page (capture only)
  // =============================================================================================
  const closeFns = [];
  global.window = { addEventListener: (t, f) => { if (t === "pagehide") closeFns.push(f); } };
  const p = load();
  const A = p.api;
  const store = p.actionFixture("act_store");
  const tabs = {
    1: { id: 1, url: "https://site.test/page?x=1" },
    2: { id: 2, url: "https://b.test/two" },
    3: { id: 3, url: "https://c.test/three" },
    4: { id: 4, url: "chrome://extensions/" },
  };
  let active = 1;
  p.setTabFn(() => ({ ...tabs[active] })); // a copy: what was read at one moment must not change afterwards
  let scriptLog = [];
  let gate = null; // { func, reached, wait } holds ONE capture
  p.setScript(async (o) => {
    scriptLog.push({ tabId: o.target.tabId, func: o.func.name });
    if (gate && gate.func === o.func.name) {
      const g = gate; gate = null;
      g.reached();
      await g.wait;
    }
    if (o.func.name === "captureActionTargets") {
      const t = o.target.tabId;
      return [{ result: t === 1 ? store.targets : { ...store.targets, title: `Tab ${t}`, documentToken: `doc${t}` } }];
    }
    return [{ result: store.snapshot }];
  });
  const captures = () => scriptLog.filter((c) => c.func === "captureActionTargets");
  const live = () => A.getLiveCapture();
  const event = async (fn, wait = 60) => { fn(); await sleep(wait); await waitIdle(p); };

  await sleep(60);
  ok("auto: opening the panel captures nothing and calls no model (capture happens on tab events and on each Suggest)", scriptLog.length === 0 && live() === null && p.state.fetchCalls.length === 0);

  active = 2;
  await event(() => p.handlers.activated({ tabId: 2 }));
  ok("auto: switching to another tab captures THAT tab (and only it)", captures().length === 1 && captures()[0].tabId === 2 && live() && live().tabId === 2 && live().title === "Tab 2", JSON.stringify(captures()));
  ok("auto: the panel shows the live capture, labelled as automatic with no model call", /Live capture \(automatic, no model call\): "Tab 2", \d+ control\(s\)\./.test(p.ids["live-capture"].textContent), p.ids["live-capture"].textContent);
  ok("auto: it never calls the model", p.state.fetchCalls.length === 0);

  scriptLog = [];
  active = 3;
  await event(() => p.handlers.updated(3, { status: "complete" }, { active: true }));
  ok("auto: a newly opened active tab is captured once it is ready (status complete)", captures().length === 1 && captures()[0].tabId === 3 && live().tabId === 3);
  scriptLog = [];
  await event(() => p.handlers.updated(3, { status: "loading" }, { active: true }));
  ok("auto: ...not while it is still loading", scriptLog.length === 0);
  await event(() => p.handlers.updated(3, { title: "new title", favIconUrl: "x" }, { active: true }));
  ok("auto: a title/favicon update captures nothing", scriptLog.length === 0);
  tabs[3].url = "https://c.test/other";
  await event(() => p.handlers.updated(3, { url: "https://c.test/other" }, { active: true }));
  ok("auto: the active page is captured again after it navigates (address change)", captures().length === 1 && captures()[0].tabId === 3);

  scriptLog = [];
  await event(() => p.handlers.updated(2, { status: "complete" }, { active: false }));
  ok("auto: an event from an INACTIVE tab captures nothing", scriptLog.length === 0);
  await event(() => p.handlers.updated(2, { status: "complete" }));
  ok("auto: an event that names another tab still captures only the ACTIVE tab, never the other one", scriptLog.length > 0 && scriptLog.every((c) => c.tabId === 3), JSON.stringify(scriptLog));

  scriptLog = [];
  active = 4;
  await event(() => p.handlers.activated({ tabId: 4 }));
  ok("auto: a restricted page (chrome://) is not captured: nothing injected, old live capture dropped, the access line says why", scriptLog.length === 0 && live() === null && /Live capture: none/.test(p.ids["live-capture"].textContent) && /Page access: unavailable/.test(p.ids["access-state"].textContent));
  active = 1;
  await event(() => p.handlers.activated({ tabId: 1 }));
  ok("auto: ...and the next normal page is captured again", live() && live().tabId === 1);

  // ---- old approvals end the moment the active tab changes ----
  p.state.fetchImpl = async () => reply(act({ action: "click", target_id: [...A.getActionContext().records.values()].find((r) => r.name === "Sale").id }));
  p.ids["prompt-input"].value = "open the sale page";
  p.ids["suggest-button"].fire("click");
  await waitIdle(p);
  ok("auto: setup: a proposal with a pending approval is on screen", A.getPendingApproval() !== null && p.ids["approve-button"].hidden === false, p.ids.status.textContent);
  const fetchesBefore = p.state.fetchCalls.length;
  p.handlers.activated({ tabId: 1 }); // NO await: the approval must end immediately, not after the capture
  ok("auto: the old approval is invalidated IMMEDIATELY on a tab switch (synchronously, before any new capture)", A.getPendingApproval() === null && p.ids["approve-button"].hidden === true && A.getActionContext() === null);
  await sleep(60); await waitIdle(p);
  ok("auto: the new capture then ran, with no model call and no action", live() && p.state.fetchCalls.length === fetchesBefore && !scriptLog.some((c) => c.func === "performApprovedAction"));
  p.ids["prompt-input"].value = "open the sale page";
  p.ids["suggest-button"].fire("click");
  await waitIdle(p);
  ok("auto: setup again: approval pending", A.getPendingApproval() !== null);
  p.handlers.updated(1, { status: "loading" }, { active: true });
  ok("auto: a navigation also invalidates the old approval immediately", A.getPendingApproval() === null);
  await sleep(40);

  // ---- a capture that finishes late is discarded ----
  scriptLog = [];
  let reached; const reachedP = new Promise((r) => (reached = r));
  let release; const waitP = new Promise((r) => (release = r));
  gate = { func: "captureActionTargets", reached, wait: waitP };
  active = 1;
  p.handlers.activated({ tabId: 1 });
  await reachedP; // the capture of tab 1 is now being read, and is held
  active = 2;
  p.handlers.activated({ tabId: 2 }); // another tab became active meanwhile
  await sleep(80); await waitIdle(p); // the newer capture (tab 2) completes first
  ok("auto: setup: the newer capture (tab 2) is shown while the older one is still being read", live() && live().tabId === 2);
  release(); // the OLDER capture (tab 1) now finishes, late
  await sleep(80); await waitIdle(p);
  ok("auto: a capture that finishes late (after another tab became active) is discarded: it does not replace the newer one", live() && live().tabId === 2 && live().title === "Tab 2", JSON.stringify(live()));
  scriptLog = [];
  let reached2; const reachedP2 = new Promise((r) => (reached2 = r));
  let release2; const waitP2 = new Promise((r) => (release2 = r));
  gate = { func: "captureActionTargets", reached: reached2, wait: waitP2 };
  p.handlers.activated({ tabId: 2 });
  await reachedP2;
  tabs[2].url = "https://b.test/navigated-meanwhile"; // the document changed while it was being read (no event yet)
  release2();
  await sleep(80); await waitIdle(p);
  ok("auto: a capture whose page changed address while it was read is discarded too", live() === null || live().urlStripped === "https://b.test/navigated-meanwhile", JSON.stringify(live()));
  tabs[2].url = "https://b.test/two";

  // ---- deferred while a request or an approved action is running ----
  p.setScript(async (o) => {
    scriptLog.push({ tabId: o.target.tabId, func: o.func.name });
    if (o.func.name === "captureActionTargets") return [{ result: o.target.tabId === 1 ? store.targets : { ...store.targets, title: `Tab ${o.target.tabId}`, documentToken: `doc${o.target.tabId}` } }];
    return [{ result: store.snapshot }];
  });
  active = 1; scriptLog = [];
  let holdReq; const holdP = new Promise((r) => (holdReq = r));
  let reqStarted; const reqStartedP = new Promise((r) => (reqStarted = r));
  p.state.fetchImpl = async () => { reqStarted(); await holdP; return reply(act({ action: "ask_user", question: "Which one?" })); };
  p.ids["prompt-input"].value = "open the sale page";
  p.ids["suggest-button"].fire("click");
  await reqStartedP; // the model request is in flight
  active = 3;
  p.handlers.activated({ tabId: 3 });
  await sleep(60);
  ok("auto: while a model request is running, the automatic capture waits (it never interleaves)", !scriptLog.some((c) => c.tabId === 3), JSON.stringify(scriptLog));
  holdReq(); await waitIdle(p); await sleep(80); await waitIdle(p);
  ok("auto: ...and runs right after it finishes", scriptLog.some((c) => c.tabId === 3 && c.func === "captureActionTargets"));

  // ---- the panel closing stops everything ----
  scriptLog = [];
  active = 2;
  p.handlers.activated({ tabId: 2 }); // a capture is scheduled...
  closeFns.forEach((f) => f()); // ...and the panel closes before it runs
  await sleep(80);
  ok("auto: closing the panel cancels a scheduled capture", scriptLog.length === 0 && live() === null);
  await event(() => p.handlers.activated({ tabId: 3 }));
  await event(() => p.handlers.updated(3, { status: "complete" }, { active: true }));
  ok("auto: after the panel closed, tab events capture nothing", scriptLog.length === 0);
  ok("auto: no automatic action: nothing was ever dispatched during all of the above", !scriptLog.some((c) => c.func === "performApprovedAction"));

  // =============================================================================================
  // 2. Dummy secrets stay out of the model request, the UI and the logs; ordinary state is used
  // =============================================================================================
  global.window = { addEventListener() {} };
  const q = load();
  const B = q.api;
  const dummies = ["DUMMY_PW_1", "DUMMY_CARDNO_2", "DUMMY_CCNUM_3", "DUMMY_CVV_4", "DUMMY_SECCODE_5", "DUMMY_OTP_6", "DUMMY_APIKEY_7", "DUMMY_VERIF_8", "DUMMY_PIN_9", "DUMMY_AUTH_10", "DUMMY_EXPIRY_11", "DUMMY_MONTH_12", "EDITABLE_MARK_13", "4111 1111 1111 1111"];
  consoleLines.length = 0;
  q.useAction("act_secrets");
  q.state.fetchImpl = async () => reply(act({ action: "type", target_id: [...B.getActionContext().records.values()].find((r) => r.name === "Username").id, text: "hello" }));
  q.ids["prompt-input"].value = "type hello into the username";
  q.ids["suggest-button"].fire("click");
  await waitIdle(q);
  const body = JSON.stringify(q.state.fetchCalls[0].body);
  const ui = allUiText(q);
  ok("secrets: no dummy secret is in the request sent to the model", dummies.every((m) => !body.includes(m)), dummies.filter((m) => body.includes(m)).join(","));
  ok("secrets: ...nor anywhere in the UI text (proposal, controls list, status, checks)", dummies.every((m) => !ui.includes(m)), dummies.filter((m) => ui.includes(m)).join(","));
  ok("secrets: ...nor in any console output", consoleLines.every((l) => dummies.every((m) => !l.includes(m))) && consoleLines.length === 0, consoleLines.join(" | ").slice(0, 200));
  ok("secrets: the ordinary fields next to them ARE in the request (username, notes, passenger name, checkbox state, selected option)", ["ORD_USER_MARK", "ORD_NOTES_MARK", "ORD_PASSENGER_MARK", "LARGE_MARK"].every((m) => body.includes(m)));
  ok("secrets: the model sees field state in plain words: value, checked / not checked, selected", /value: \\"ORD_USER_MARK\\"/.test(body) && /not checked/.test(body) && /selected: \\"LARGE_MARK\\"/.test(body));
  ok("secrets: a card-shaped value in an ordinary field is withheld, and the line says so without showing it", /value: withheld/.test(body) && !body.includes("4111"));
  ok("secrets: the 'controls sent' panel text shows the same lines (so you can see exactly what was sent)", /value: "ORD_USER_MARK"/.test(q.actionView().targets) && dummies.every((m) => !q.actionView().targets.includes(m)));
  // Typing a secret stays banned, however it is asked.
  for (const [label, goal, build] of [
    ["into the password field", "type DUMMY_PW_1 into the password", (c) => act({ action: "type", target_id: [...c.records.values()].find((r) => r.kind === "password-field").id, text: "DUMMY_PW_1" })],
    ["into the CVV field", "type 123 into the CVV", (c) => act({ action: "type", target_id: [...c.records.values()].find((r) => r.name === "CVV").id, text: "123" })],
    ["into a field identified only by its label (Verification code)", "type 123456 into the verification code", (c) => act({ action: "type", target_id: [...c.records.values()].find((r) => r.name === "Verification code").id, text: "123456" })],
    ["a card number into an ordinary field", "type 4111 1111 1111 1111 into the username", (c) => act({ action: "type", target_id: [...c.records.values()].find((r) => r.name === "Username").id, text: "4111 1111 1111 1111" })],
    ["a search for a secret-shaped token", "search for sk_" + "live_abcdefghijklmnopqrstuvwxyz0123", (c) => act({ action: "search", target_id: [...c.records.values()].find((r) => r.name === "Username").id, text: "sk_" + "live_abcdefghijklmnopqrstuvwxyz0123" })],
  ]) {
    q.useAction("act_secrets");
    q.state.fetchImpl = async () => reply(build(B.getActionContext()));
    q.ids["prompt-input"].value = goal;
    q.ids["suggest-button"].fire("click");
    await waitIdle(q);
    ok(`secrets: typing ${label} is refused: rejected, no Approve`, q.actionView().rejected && B.getPendingApproval() === null && q.ids["approve-button"].hidden === true, q.actionView().checks.join("//"));
  }
  ok("secrets: still no secret in the UI or logs after all of those proposals", dummies.every((m) => !allUiText(q).includes(m)) && consoleLines.length === 0);

  // =============================================================================================
  // 3. Search controls survive truncation; scroll validity; plans; confirmation text; normalization
  // =============================================================================================
  const many = q.actionFixture("act_many").targets;
  const mk = (n, over) => ({ n, key: 5000 + n, kind: "button", inputType: "", name: `Extra ${n}`, nameSource: "content", disabled: false, readOnly: false, submit: false, sensitive: false, viewport: "below", rect: { x: 10, y: 5000, w: 80, h: 20 }, region: "page", signature: "0123abcd", value: null, valueLen: 0, valueWithheld: false, checked: null, selected: null, search: null, ...over });
  const withSearch = JSON.parse(JSON.stringify(many));
  const baseN = withSearch.targets.length;
  withSearch.targets.push(mk(baseN + 1, { key: 9001, kind: "text-field", inputType: "search", name: "Search", region: "search", signature: "aaaaaaa1", value: "", search: { field: true, via: "control", reason: "", submit: { key: 9002, name: "Go", signature: "aaaaaaa2" }, formKey: 77 } }));
  withSearch.targets.push(mk(baseN + 2, { key: 9002, name: "Go", submit: true, region: "search", signature: "aaaaaaa2" }));
  const nw = B.normalizeTargetCapture(withSearch);
  const recsPinned = B.buildActionRecords(nw, "a1");
  const packedPinned = B.packTargets(recsPinned, B.ACTION_TARGET_BUDGET_CHARS);
  const fieldRec = [...recsPinned.values()].find((r) => r.name === "Search");
  const goRec = [...recsPinned.values()].find((r) => r.name === "Go");
  ok("truncation: the list is cut for size (some controls are omitted)", packedPinned.shown < packedPinned.total && /OMITTED/.test(packedPinned.note), `${packedPinned.shown}/${packedPinned.total}`);
  ok("truncation: the search field AND its submit control survive it, and come first", fieldRec.shown && goRec.shown && packedPinned.lines[0].includes(fieldRec.id) && packedPinned.lines[1].includes(goRec.id), packedPinned.lines.slice(0, 2).join(" // "));
  const unpinned = JSON.parse(JSON.stringify(withSearch));
  unpinned.targets.find((t) => t.name === "Search").search = null;
  const recsPlain = B.buildActionRecords(B.normalizeTargetCapture(unpinned), "a1");
  B.packTargets(recsPlain, B.ACTION_TARGET_BUDGET_CHARS);
  ok("truncation: without being identified as a search path the same controls are cut (so the pin is what saves them)", ![...recsPlain.values()].find((r) => r.name === "Search").shown && ![...recsPlain.values()].find((r) => r.name === "Go").shown);

  const V = { w: 1280, h: 800 };
  const ctxFor = (scroll) => ({ version: "a1", records: new Map(), scroll, viewport: V });
  const scr = (dir, scroll) => B.validateActionReply(JSON.stringify(act({ action: "scroll", direction: dir })), "scroll", ctxFor(scroll));
  let rr = scr("up", { top: 0, max: 3000 });
  ok("scroll: up at the top -> REJECTED at proposal time (a blocked step, not valid-with-a-warning)", rr.kind === "rejected" && rr.blocks.some((x) => /not possible: the page is already at the top/.test(x)) && !rr.warnings);
  rr = scr("down", { top: 3000, max: 3000 });
  ok("scroll: down at the bottom -> rejected", rr.kind === "rejected" && /already at the bottom/.test(rr.blocks.join()));
  rr = scr("down", { top: 0, max: 0 });
  ok("scroll: a page that does not scroll -> rejected", rr.kind === "rejected" && /does not scroll/.test(rr.blocks.join()));
  rr = scr("down", { top: 0, max: 3000 });
  ok("scroll: with room -> valid, and the check says how much", rr.kind === "valid" && rr.checks.some((c) => /There is room to scroll down \(3000 px remain; one step is at most 640 px\)/.test(c.text)));
  rr = scr("up", { top: 10, max: 3000 });
  ok("scroll: 10 px of room is still possible, limited to what remains", rr.kind === "valid" && B.scrollPlan("up", { top: 10, max: 3000 }, V).step === 10);

  // search plan / exact-match rule
  const rec = (over) => ({ value: "", valueLen: 0, valueWithheld: false, search: { field: true, via: "control", reason: "", submit: { key: 2, name: "Search", signature: "aaaaaaa2" }, formKey: 3 }, ...over });
  ok("plan: an empty box is filled, then submitted", B.searchPlan(rec(), "black Nike shoes").skipFill === false);
  ok("plan: exactly the same query is NOT retyped", B.searchPlan(rec({ value: "black Nike shoes", valueLen: 16 }), "black Nike shoes").skipFill === true);
  ok("plan: a different case, extra space or a longer clipped value is not 'exact'", !B.searchPlan(rec({ value: "Black Nike shoes", valueLen: 16 }), "black Nike shoes").skipFill && !B.searchPlan(rec({ value: "black Nike shoes ", valueLen: 17 }), "black Nike shoes").skipFill && !B.searchPlan(rec({ value: "black Nike shoes", valueLen: 400 }), "black Nike shoes").skipFill);
  ok("plan: a withheld value is never treated as a match", !B.searchPlan(rec({ value: null, valueWithheld: true }), "x").skipFill);
  ok("path: only identical keys and signatures count as the same submission path", B.sameSearchPath(rec().search, rec().search) && !B.sameSearchPath(rec().search, { ...rec().search, submit: { key: 2, name: "Search", signature: "bbbbbbb2" } }) && !B.sameSearchPath(rec().search, { ...rec().search, via: "form", submit: null }) && !B.sameSearchPath(rec().search, null));

  // confirmation text
  const ci = B.consequenceInfo({ name: "Delete account", kind: "button", submit: false });
  const cb = B.consequenceInfo({ name: "Buy now", kind: "button", submit: true });
  ok("confirm: a consequential-looking name gives a question, a Known line and an Unknown line (not a prediction)", ci && /Delete/.test(ci.word) && /^Known: this is a button on the page\. What the page does when it is used is not known to Cloudy\.$/.test(ci.known) && /^Unknown: the real effect\./.test(ci.unknown));
  ok("confirm: a submit button is known to submit a form, and its effect is still unknown", cb && /submits a form on the page\. What the site does with that form is not known/.test(cb.known) && /Unknown/.test(cb.unknown));
  ok("confirm: an ordinary name needs no confirmation", B.consequenceInfo({ name: "Search", kind: "button", submit: false }) === null && B.consequenceInfo({ name: "Add to cart", kind: "button", submit: false }) === null);
  ok("confirm: nothing is inferred from the name: no 'will', no outcome words in Known/Unknown", ![ci, cb].some((x) => /\bwill\b|permanently|irreversible|charged/i.test(x.known + x.unknown)));

  // normalization defence
  const raw = JSON.parse(JSON.stringify(q.actionFixture("act_secrets").targets));
  raw.targets[0].value = "a\u0000b\nc";
  const nraw = B.normalizeTargetCapture(raw);
  ok("normalize: control characters in a read value become spaces (a value cannot add lines to the prompt)", nraw.targets[0].value === "a b c");
  raw.targets[0].search = { field: true, via: "control", reason: "x", submit: { key: 5, name: "n", signature: "not-hex" }, formKey: 1 };
  ok("normalize: a search path with a malformed submit target is downgraded to 'none'", B.normalizeTargetCapture(raw).targets[0].search === null || B.normalizeTargetCapture(raw).targets[0].search.via === "none");

  print(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  print(`operations tests: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

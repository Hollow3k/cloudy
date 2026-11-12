// Whole response-to-display path, with a fake model reply: raw reply -> parse ->
// citation checking -> what the panel draws and says. Uses the real sidepanel.js
// in a fake browser (tests/fake-panel.js) and real captures from tests/.out/.
// This is NOT the installed extension and NOT the local model.
const fs = require("fs");
const path = require("path");
const { load } = require("./fake-panel.js");
const out = path.join(__dirname, ".out");
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 240) : ""}`);

const sentIds = (ctx, type) => [...ctx.records.values()].filter((r) => r.sent && (!type || r.type === type)).map((r) => r.id);
const idOf = (ctx, type, pred) => { for (const r of ctx.records.values()) if (r.type === type && r.sent && pred(r)) return r.id; return null; };
const textOf = (v) => v.all + v.reply + v.status;

(async () => {
  const p = load();
  const A = p.api;

  // ===== 1. The 20-citation cap used to stop CHECKING =====
  // 23 valid IDs exist in this capture (headings, links, a nav link, a control, the text).
  async function citeN(n, extraBad = []) {
    p.useCapture("mdn_live");
    p.replyWith((v, ctx) => ({ status: "answered", answer: "summary", entries: [], citations: [...sentIds(ctx).slice(0, n), ...extraBad.map((x) => (typeof x === "function" ? x(v) : x))] }));
    await p.ask("summarize this page");
    return p.view();
  }
  p.useCapture("mdn_live"); p.replyWith((v, ctx) => ({ status: "answered", answer: "x", entries: [], citations: [] })); await p.ask("q");
  const totalValid = sentIds(A.getPageContext()).length;
  ok("1: fixture has more than 20 valid IDs (so the cap is reachable)", totalValid >= 22, String(totalValid));
  let v = await citeN(19);
  ok("1: 19 valid citations: 19 cards, no warnings, count exact", v.cards.length === 19 && v.warnings.length === 0 && /IDs found in this capture: 19\./.test(v.status), v.status.slice(0, 120));
  v = await citeN(20);
  ok("1: exactly 20: 20 cards, none hidden", v.cards.length === 20 && !/not drawn/.test(v.all + v.status), String(v.cards.length));
  v = await citeN(totalValid);
  ok(`1: all ${totalValid} valid IDs (above the cap): all counted as found, 20 drawn, the rest stated as checked-but-not-drawn`, v.cards.length === 21 && /IDs found in this capture: 23\./.test(v.status) && /3 more cited source\(s\) were checked and exist in the capture, but are not drawn \(display limit 20\)/.test(v.cards[20]) && /3 more checked source\(s\) are not drawn/.test(v.status), v.status.slice(0, 200));
  v = await citeN(totalValid, [(ver) => ver + ":H9999", "s999:H1", "s1:Z9"]);
  ok("1: invalid IDs AFTER the 20th valid one are still caught (the old code never looked at them)", v.warnings.length === 3 && v.warnings.some((w) => /H9999 does not exist/.test(w)) && v.warnings.some((w) => /s999:H1 belongs to a different capture/.test(w)) && v.warnings.some((w) => /s1:Z9 is not a valid evidence ID/.test(w)) && /3 problem\(s\)/.test(v.status) && !/not checked/.test(textOf(v)), v.status.slice(0, 200));
  const r26 = A.resolveCitations([...sentIds(A.getPageContext()).slice(0, 20), "s999:H1", A.getPageContext().version + ":H9999", "s1:Z9"], A.getPageContext());
  ok("1: resolveCitations itself checks every distinct ID (no 'ignored' result any more)", r26.verified.length === 20 && r26.problems.length === 3 && !("ignored" in r26) && A.MAX_CITED === undefined);

  // ===== 2. Duplicates, invalid, stale and odd forms =====
  v = await citeN(3, [(ver) => ver + ":H1", (ver) => ver + ":H1", "  " + "s1:H1" + "  "]);
  ok("2: duplicates are checked once (a cited ID appears as one card)", v.cards.filter((c) => c.startsWith(A.getPageContext().version + ":H1 ")).length === 1);
  p.useCapture("mdn_live");
  p.replyWith((ver, ctx) => ({ status: "answered", answer: "x", entries: [], citations: ["[" + ver + ":H1]", "https://evil.test/steal", "s999:L1", 42, null, { id: ver + ":H1" }, ver + ":Q1", ""] }));
  await p.ask("q"); v = p.view();
  ok("2: bracketed, URL, wrong-snapshot, non-text, object, unknown-type, empty: each reported, none drawn", v.cards.length === 0 && v.warnings.length === 8 && v.warnings.filter((w) => /\(not text\)/.test(w)).length === 3 && v.warnings.some((w) => /evil\.test.*not a valid evidence ID/.test(w)) && v.warnings.some((w) => /different capture/.test(w)), JSON.stringify(v.warnings).slice(0, 220));
  ok("2: no destination appears anywhere (a model-written URL never becomes a link or card)", !/evil\.test\/steal/.test(v.cards.join("") + v.listed.join("")) && !/https:\/\/site\.test|developer\./.test(v.cards.join("") + v.listed.join("")));
  // The id of an entry that exists but was never shown to the model.
  p.useCapture("mdn_live");
  p.replyWith((ver, ctx) => { const unsent = [...ctx.records.values()].find((r) => !r.sent); return { status: "answered", answer: "x", entries: [], citations: [unsent.id] }; });
  await p.ask("q"); v = p.view();
  ok("2: an ID that exists but was never shown to the model is not accepted as a source", v.cards.length === 0 && /not part of the excerpt shown to the model/.test(v.warnings[0]));

  // ===== 3. Malformed replies, defensive bound =====
  const bad = [
    ["not JSON", "I think so", /not valid JSON/],
    ["JSON null", "null", /expected "status"/],
    ["old shape", { answer: "x", evidence: [] }, /expected "status"/],
    ["unknown status", { status: "maybe", answer: "x", entries: [], citations: [] }, /status "maybe" is not one of/],
    ["citations not a list", { status: "answered", answer: "x", entries: [], citations: "s1:H1" }, /"citations" \(list\)/],
    ["entries not a list", { status: "answered", answer: "x", entries: "s1:H1", citations: [] }, /"entries" field was not a list/],
    ["answer not text", { status: "answered", answer: 5, entries: [], citations: [] }, /"answer" \(text\)/],
    ["absurd number of IDs", { status: "answered", answer: "x", entries: [], citations: Array.from({ length: 1001 }, (_, i) => "s1:H" + i) }, /named 1001 evidence IDs, more than the 1000/],
  ];
  for (const [name, payload, re] of bad) {
    p.useCapture("mdn_live"); await p.ask("q", payload); v = p.view();
    ok(`3: ${name}: rejected clearly, raw shown unverified, no sources`, v.isError === true && /was rejected because/.test(v.status) && re.test(v.status) && v.sourcesHidden === true && !/^Done/.test(v.status), v.status.slice(0, 150));
  }
  p.useCapture("mdn_live"); await p.ask("q", { status: "answered", answer: "ok", citations: [] }); v = p.view();
  ok("3: a reply without an entries field is still accepted (treated as listing nothing) and flagged as uncited", !v.isError && /cites no captured evidence/.test(v.warnings[0] || ""));
  p.useCapture("mdn_live");
  p.replyWith((ver, ctx) => ({ status: "answered", answer: "x", entries: [], citations: Array.from({ length: 1000 }, (_, i) => (i < 10 ? sentIds(ctx)[i] : "s999:L" + i)) }));
  await p.ask("q"); v = p.view();
  ok("3: 1000 IDs (the bound) are all checked; display of problems is capped and says so", /IDs found in this capture: 10, 990 problem\(s\)/.test(v.status) && v.warnings.length === 21 && /970 more problem\(s\) were found but are not listed/.test(v.warnings[20]), v.status.slice(0, 150));

  // ===== 4. Exact headings come from the capture, not from model prose =====
  p.useCapture("mdn_live");
  let ctx = null;
  p.replyWith((ver, c) => {
    ctx = c;
    const h = (t) => idOf(c, "heading", (r) => r.text === t);
    return { status: "answered", answer: 'The first three: h3: "Attribute" , h1: "-<h6> HTML section heading elements", h9: "Nesting".', entries: [h("<h1>–<h6> HTML section heading elements"), h("Attributes"), h("Nesting")], citations: [] };
  });
  await p.ask("List the first three headings with their levels."); v = p.view();
  ok("4: listed entries show exact text and the REAL levels, in the model's order", v.listed.length === 3 && v.listed[0].endsWith('Heading h1: "<h1>–<h6> HTML section heading elements"') && v.listed[1].endsWith('Heading h2: "Attributes"') && v.listed[2].endsWith('Heading h4: "Nesting"'), v.listed.join(" // "));
  ok("4: literal <h1>/<h6> in the heading text is kept; the model's mistyped prose does not change the entries", v.listed[0].includes("<h1>–<h6>") && !v.listed.join("").includes("Attribute\"") && !v.listed.join("").includes("-<h6> HTML"));
  ok("4: entries are drawn under their own heading and are not repeated under Cited sources", v.listedHeadingHidden === false && v.cards.length === 0);
  ok("4: the ID counter differs from the level (H3 is level 2, H9 is level 4) and the card uses the stored level", /H3 Heading h2:/.test(v.listed[1]) && /H9 Heading h4:/.test(v.listed[2]), v.listed[1] + " | " + v.listed[2]);
  ok("4: status says listed entries are copied from the capture and the text is model-written; no 'verified'", /3 listed entries are copied from the capture; the answer text is written by the model/.test(v.status) && !/verified/i.test(v.status), v.status.slice(0, 220));
  ok("4: the lead-in prose is shown as written (textContent)", v.reply.startsWith("The first three:"));

  // order and overlap between entries and citations
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", answer: "Here they are.", entries: [ver + ":H9", ver + ":H1", ver + ":H9"], citations: [ver + ":H1", ver + ":L1"] }));
  await p.ask("q"); v = p.view();
  ok("4: model order kept; a duplicate entry and an ID in both lists are drawn once; the other citation is a normal card", v.listed.length === 2 && /H9 Heading h4/.test(v.listed[0]) && /H1 Heading h1/.test(v.listed[1]) && v.cards.length === 1 && /L1 Link:/.test(v.cards[0]), v.listed.join(" // ") + " || " + v.cards.join(" // "));

  // invalid entries are warned, never drawn
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", answer: "Here.", entries: [ver + ":H1", ver + ":H9999", "s999:H2", "[" + ver + ":H3]"], citations: [] }));
  await p.ask("q"); v = p.view();
  ok("4: invalid / nonexistent / stale / bracketed ENTRIES are warned and not drawn; the valid one still is", v.listed.length === 1 && v.warnings.length === 3 && /IDs found in this capture: 1, 3 problem\(s\)/.test(v.status), v.status.slice(0, 160));

  // A model that copies whole snapshot lines into "entries": resolved by the leading ID, drawn from the capture.
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", answer: "Two headings.", entries: [ver + ':H1 | h1: "<h1>-<h6> MISTYPED"', ver + ':H2 | h6: "Try it FAKE"'], citations: [] }));
  await p.ask("List the first two headings."); v = p.view();
  ok("4: whole snapshot lines in entries are read by their leading ID; the mistyped rest is ignored and never drawn", v.listed.length === 2 && v.warnings.length === 0 && v.listed[0].endsWith('Heading h1: "<h1>–<h6> HTML section heading elements"') && v.listed[1].endsWith('Heading h2: "Try it"') && !v.all.includes("MISTYPED") && !v.all.includes("FAKE"), v.listed.join(" // "));
  p.replyWith((ver, c) => ({ status: "answered", answer: "x", entries: [ver + ':H1 | h1: ok', ver + ":H1"], citations: [ver + ':H1 | h1: again'] }));
  await p.ask("q"); v = p.view();
  ok("4: the same entry given as a bare ID, a whole line and a citation is drawn once", v.listed.length === 1 && v.cards.length === 0 && v.warnings.length === 0);
  p.replyWith((ver, c) => ({ status: "answered", answer: "x", entries: [ver + ':H1|h1: nobar-spaces', ver + ' :H1', "[" + ver + ":H1] | h1"], citations: [] }));
  await p.ask("q"); v = p.view();
  ok("4: lookalike forms (no spaces around the bar, space before the colon, brackets) are still rejected", v.listed.length === 0 && v.warnings.length === 3, v.warnings.join(" || ").slice(0, 200));

  // ===== 5. Links: destinations come only from stored data =====
  p.useCapture("ref_contents_main");
  p.replyWith((ver, c) => ({ status: "answered", answer: "Two links: https://evil.test/fake and https://site.test/guides/headings?lang=en&view=FAKE", entries: [idOf(c, "link", (r) => r.label === "the guide"), idOf(c, "link", (r) => r.label === "font-size")], citations: [] }));
  await p.ask("List two links with their destinations."); v = p.view();
  ok("5: link entries show the STORED destination (functional query kept), not the model's URLs", v.listed.length === 2 && v.listed[0].includes("https://site.test/guides/headings?lang=en&view=full") && !v.listed.join("").includes("view=FAKE") && !v.listed.join("").includes("evil.test"), v.listed[0]);
  ok("5: destination is plain text with a Copy button, never an <a>", v.listedEls.every((li) => { let a = 0, b = 0; li.walk((n) => { if (n.tag === "a") a++; if (n.tag === "button") b++; }); return a === 0 && b === 1; }));
  p.useCapture("privacy");
  p.replyWith((ver, c) => ({ status: "answered", answer: "Here.", entries: [idOf(c, "link", (r) => r.label === "Login callback"), idOf(c, "nav", (r) => r.label === "Nav login")], citations: [] }));
  await p.ask("List the login links."); v = p.view();
  ok("5: a withheld (credential-bearing) destination stays withheld in listed entries", v.listed.length === 2 && v.listed.every((t) => /withheld as possibly credential-bearing/.test(t)) && !/SECRETTOKEN|NAVSECRET|access_token/.test(textOf(v)), v.listed.join(" // ").slice(0, 200));
  p.useCapture("ref_contents_main");
  p.replyWith((ver, c) => ({ status: "answered", answer: "One nav link.", entries: [idOf(c, "nav", () => true)], citations: [] }));
  await p.ask("Give me exactly one navigation link."); v = p.view();
  ok("5: a navigation link is labelled as navigation", v.listed.length === 1 && /Navigation link \(/.test(v.listed[0]));

  // ===== 6. Display caps for listed entries are only about drawing =====
  const many = { title: "Many", url: "https://site.test/page", readyState: "complete",
    selection: { mode: "fallback", regionType: "none", reason: "no-semantic-region", refined: false, candidatesFound: 0, candidates: 0, rejected: { notRendered: 0, insideChrome: 0, skipped: 0, littleText: 0 }, otherRegions: 0, textChars: 0, linkDensityPct: 0, coveragePct: -1, otherOutside: false, fallbackIncludesChrome: false, excluded: [] },
    headings: Array.from({ length: 40 }, (_, i) => ({ level: (i % 6) + 1, text: "H" + i, where: "page" })), headingsCapped: false, headingsOutsideScope: 0,
    text: "tiny", textTruncated: false,
    links: Array.from({ length: 60 }, (_, i) => ({ label: "L" + i, status: "ok", href: "https://s.test/" + i })), linksCapped: false,
    navLinks: [], navLinksCapped: false, controls: [], controlsCapped: false, iframeCount: 0 };
  p.useSnapshotObject(many);
  p.replyWith((ver, c) => ({ status: "answered", answer: "All of them.", entries: sentIds(c), citations: [] }));
  await p.ask("List everything."); v = p.view();
  const sentMany = sentIds(A.getPageContext()).length;
  ok("6: a very large listing: every entry is checked and counted; drawing stops at 40 with a stated remainder", sentMany > 45 && v.listed.length === 41 && new RegExp(`${sentMany - 40} more listed entries were checked but are not drawn \\(display limit 40\\)`).test(v.listed[40]) && new RegExp(`IDs found in this capture: ${sentMany}\\.`).test(v.status), `sent ${sentMany}; drawn ${v.listed.length}; ` + v.status.slice(0, 100));

  // ===== 7. Abstention and missing evidence =====
  p.useCapture("mdn_live");
  await p.ask("What is the price?", { status: "insufficient_evidence", answer: "The captured page does not say.", entries: [], citations: [] }); v = p.view();
  ok("7: insufficient_evidence with nothing named: neutral status, answer shown, no warning, Sources hidden", /^Not enough captured information\./.test(v.status) && v.isError === false && v.sourcesHidden === true && v.warnings.length === 0 && v.reply === "The captured page does not say.");
  await p.ask("What is the price?", { status: "insufficient_evidence", answer: "No.", entries: ["s999:H1"], citations: ["s1:Z1"] }); v = p.view();
  ok("7: insufficient_evidence does NOT hide invalid IDs: both still warned", v.warnings.length === 2 && v.sourcesHidden === false && /^Not enough captured information\./.test(v.status));
  await p.ask("q", { status: "answered", answer: "Made up.", entries: [], citations: [] }); v = p.view();
  ok("7: answered with nothing named: visible unsupported-evidence note, not marked as backed", v.warnings.length === 1 && /cites no captured evidence/.test(v.warnings[0]) && /No captured evidence was cited\./.test(v.status) && !/IDs found/.test(v.status));
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", answer: "", entries: [ver + ":H1"], citations: [] }));
  await p.ask("q"); v = p.view();
  ok("7: an empty lead-in with listed entries is not called an empty reply", !/empty reply/.test(v.status) && v.listed.length === 1);

  // ===== 8. Stale responses, cancellation, a cleared capture =====
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", answer: "late", entries: [ver + ":H1"], citations: [ver + ":L1"] }));
  let release;
  p.state.fetchImpl = (u, o) => new Promise((res) => (release = () => res({ ok: true, json: async () => ({ response: JSON.stringify({ status: "answered", answer: "late", entries: [A.getPageContext() ? A.getPageContext().version + ":H1" : "s1:H1"], citations: [] }), prompt_eval_count: 1, total_duration: 1e9 }) })));
  p.ids["ask-page-button"].fire("click"); await p.tick(60);
  p.handlers.activated({ tabId: 99 }); release(); await p.tick(60); v = p.view();
  ok("8: capture cleared before the reply arrived: nothing is checked or drawn as a source, and it says so", v.reply === "late" && v.listed.length === 0 && v.cards.length === 0 && /could not be checked because the capture was cleared/.test(v.status) && /can't be checked/.test(v.note));
  p.state.fetchCalls = []; let resolveOld; const slow = new Promise((res) => (resolveOld = res));
  let calls = 0;
  p.state.fetchImpl = () => (++calls === 1 ? slow : Promise.resolve({ ok: true, json: async () => ({ response: JSON.stringify({ status: "insufficient_evidence", answer: "NEW", entries: [], citations: [] }) }) }));
  const first = A.runRequest("A", async () => ({ prompt: "old", structured: true, version: "s1", format: A.REPLY_SCHEMA }));
  await p.tick(10);
  await A.runRequest("B", async () => ({ prompt: "new", structured: true, version: "s1", format: A.REPLY_SCHEMA }));
  resolveOld({ ok: true, json: async () => ({ response: JSON.stringify({ status: "answered", answer: "OLD", entries: ["s1:H1"], citations: ["s1:L1"] }) }) });
  await first; await p.tick(30); v = p.view();
  ok("8: an old reply cannot overwrite a newer reply, status, listed entries or sources", v.reply === "NEW" && /^Not enough captured information\./.test(v.status) && v.listed.length === 0 && v.sourcesHidden === true);
  p.useCapture("mdn_live");
  p.state.fetchImpl = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))));
  p.ids["prompt-input"].value = "q"; p.ids["ask-page-button"].fire("click"); await p.tick(60); p.ids["stop-button"].fire("click"); await p.tick(40); v = p.view();
  ok("8: Stop during the request: cancelled, nothing drawn, controls back", /Cancelled/.test(v.status) && v.reply === "" && v.sourcesHidden === true && !p.ids["send-button"].disabled);

  // ===== 9. Unchanged contract and safe rendering =====
  const sidepanel = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
  ok("9: schema: status/answer/entries/citations, all required, no extras, model unchanged", JSON.stringify(A.REPLY_SCHEMA.required) === '["status","entries","citations","answer"]' && JSON.stringify(Object.keys(A.REPLY_SCHEMA.properties)) === '["status","entries","citations","answer"]' && A.REPLY_SCHEMA.additionalProperties === false && A.REPLY_SCHEMA.properties.entries.type === "array" && A.MODEL === "qwen3:4b-instruct" && A.SNAPSHOT_BUDGET_CHARS === 4000 && !/num_ctx|options\s*:/.test(sidepanel.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")));
  ok("9: model text is only ever written with textContent (no innerHTML / insertAdjacentHTML / document.write)", !/innerHTML|insertAdjacentHTML|document\.write|outerHTML/.test(sidepanel));
  p.useCapture("mdn_live"); await p.ask("q", { status: "answered", answer: "<img src=x onerror=alert(1)> and <b>bold</b>", entries: ["<script>alert(1)</script>"], citations: ["<img src=x>"] }); v = p.view();
  ok("9: markup in the answer and in IDs is inert text (shown literally, no element created)", v.reply === "<img src=x onerror=alert(1)> and <b>bold</b>" && v.warnings.length === 2 && v.warnings.every((w) => /not a valid evidence ID/.test(w)) && ![p.ids.reply, ...v.listedEls, ...v.cardEls].some((e) => { let bad = false; e.walk((n) => { if (["img", "script", "b"].includes(n.tag)) bad = true; }); return bad; }));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  ok("9: permissions unchanged", JSON.stringify(manifest.permissions) === '["sidePanel","activeTab","scripting"]' && JSON.stringify(manifest.host_permissions) === '["http://localhost:11434/*"]');
  p.ids["prompt-input"].value = "say ready"; p.reply("ready"); p.state.fetchCalls = []; p.ids["prompt-form"].fire("submit", { preventDefault() {} }); await p.tick(40); v = p.view();
  ok("9: plain chat untouched: no format/system, reply as-is, no sources", !("format" in p.state.fetchCalls[0].body) && !("system" in p.state.fetchCalls[0].body) && v.reply === "ready" && v.status === "Done." && v.sourcesHidden === true);

  // ===== 10. Coverage is stated by the panel from the capture counts, not left to the model =====
  p.useCapture("mdn_live"); p.replyWith((ver) => ({ status: "answered", entries: [], citations: [ver + ":T"], answer: "A summary." })); await p.ask("Summarize this page."); v = p.view();
  const cc = A.getPageContext().counts;
  ok("10: a truncated capture is reported as partial, with the real omitted counts", /Coverage is partial: the page text was cut off; /.test(v.status) && new RegExp(`${cc.headings.total - cc.headings.shown} of ${cc.headings.total} headings`).test(v.status) && new RegExp(`${cc.links.total - cc.links.shown} of ${cc.links.total} links`).test(v.status) && /were not shown to the model/.test(v.status), v.status.slice(0, 330));
  p.useCapture("article_header"); p.replyWith((ver) => ({ status: "answered", entries: [], citations: [ver + ":T"], answer: "A summary." })); await p.ask("Summarize this page."); v = p.view();
  ok("10: a small page that fits entirely makes no partial-coverage claim", !/Coverage is partial/.test(v.status), v.status.slice(0, 200));
  const keyOrder = A.parseStructuredReply('{"answer":"a","citations":["s1:T"],"entries":[],"status":"answered"}');
  ok("10: the parser does not depend on the order of keys in the reply", keyOrder.ok && keyOrder.status === "answered" && keyOrder.citations[0] === "s1:T" && keyOrder.entries.length === 0);

  // ===== 11. Relevant versus irrelevant citations: what the panel CAN and CANNOT tell =====
  // The panel can show that a cited ID exists and what it contains, so a person can compare it with the
  // answer. It does not judge relevance. A valid but irrelevant ID is drawn like any other card, and the
  // note says a card does not show that the answer uses it correctly.
  p.useCapture("mdn_live");
  p.replyWith((ver, c) => ({ status: "answered", entries: [], citations: [ver + ":T", idOf(c, "heading", (r) => r.text === "Nesting")], answer: "The page is about HTML heading elements." }));
  await p.ask("What is this page about?"); v = p.view();
  ok("11: a valid but unrelated citation (Nesting) is shown as its real content, never as 'verified' or 'supports'", v.cards.length === 2 && v.cards.some((t) => /Heading h4: "Nesting"/.test(t)) && /does not show that the answer uses it correctly/.test(v.note) && !/verified|supports|supported|relevant/i.test(v.status + v.note), v.note.slice(0, 160));

  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  fs.writeFileSync(path.join(out, "pipeline_result.txt"), results.join("\n") + `\n\nFAILS: ${fails} of ${results.length}`);
  console.log(results.join("\n") + `\n\npipeline tests: ${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH " + e.stack + "\n\n" + results.join("\n")); process.exit(1); });

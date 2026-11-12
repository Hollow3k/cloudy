// Panel-side tests. sidepanel.js runs in Node with a FAKE DOM, a FAKE chrome API
// and a FAKE fetch. They use the real captures in tests/.out/ (made by
// dump-captures.js from tests/make-fixtures.js). No browser extension, no Ollama.
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 200) : ""}`);

class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this._text = ""; this.className = ""; this.listeners = {}; this.hidden = false; this.open = false; this.disabled = false; this.readOnly = false; this.value = ""; this.isError = false; const self = this; this.classList = { toggle(c, on) { if (c === "error") self.isError = !!on; } }; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute() {}
  addEventListener(e, f) { this.listeners[e] = f; }
  fire(e, ev) { return this.listeners[e](ev); }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
}
const ids = {};
["prompt-form", "prompt-input", "send-button", "stop-button", "ask-page-button", "status", "reply", "page-info", "excerpt-details", "excerpt", "sources-section", "sources-note", "sources-list", "sources-warnings"].forEach((i) => (ids[i] = new FakeEl(i)));
global.document = { getElementById: (i) => ids[i], createElement: (t) => new FakeEl(t) };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
const handlers = {};
let tabQueue = []; let scriptImpl = null; let scriptCalls = [];
global.chrome = {
  tabs: { query: async () => { const t = tabQueue.length > 1 ? tabQueue.shift() : tabQueue[0]; return t ? [t] : []; },
    onActivated: { addListener: (f) => (handlers.activated = f) }, onUpdated: { addListener: (f) => (handlers.updated = f) }, onRemoved: { addListener: (f) => (handlers.removed = f) } },
  scripting: { executeScript: async (o) => { scriptCalls.push(o); return scriptImpl(o); } },
};
let fetchCalls = []; let fetchImpl = null;
global.fetch = (url, opts) => { fetchCalls.push({ url, body: JSON.parse(opts.body) }); return fetchImpl(url, opts); };
const reply = (obj) => Promise.resolve({ ok: true, json: async () => ({ response: typeof obj === "string" ? obj : JSON.stringify(obj), prompt_eval_count: 800, total_duration: 2e9 }) });
const realST = setTimeout;
global.setTimeout = (f, ms) => (ms === 180000 ? realST(f, 80) : realST(f, ms));

eval(fs.readFileSync(path.join(root, "capture.js"), "utf8"));
eval(fs.readFileSync(path.join(root, "sidepanel.js"), "utf8").replace(/^const /gm, "var ").replace(/^let /gm, "var "));

const tick = (ms = 25) => new Promise((r) => realST(r, ms));
const status = () => ids.status.textContent;
const allText = (el) => { let s = ""; el.walk((n) => (s += n._text + "|")); return s; };
const warnings = () => ids["sources-warnings"].children.map((c) => c.textContent);
const cards = () => ids["sources-list"].children.map((c) => c.textContent);
const tabP = { id: 7, url: "https://site.test/page?x=1" };
const load = (n) => ({ ...JSON.parse(fs.readFileSync(path.join(out, `snap_${n}.json`), "utf8")), url: "https://site.test/page", readyState: "complete" });
const SN = {}; for (const n of fs.readFileSync(path.join(out, "names.txt"), "utf8").split(/\r?\n/).filter(Boolean)) SN[n] = load(n);
const evid = (n, v = "s1", budget = 4000) => buildEvidence(normalizeSnapshot(SN[n]), v, budget);
const sectionOf = (text, start) => { const i = text.indexOf(start); if (i < 0) return ""; const rest = text.slice(i); const j = rest.indexOf("\n\n"); return j < 0 ? rest : rest.slice(0, j); };
const textPart = (t) => { const i = t.indexOf("PAGE TEXT EXCERPT"); const j = t.indexOf("\n\nLINKS"); return t.slice(i, j < 0 ? undefined : j); };
const fresh = (q = "a question", snap = "ref_contents_main") => { fetchCalls = []; scriptCalls = []; ids["prompt-input"].value = q; tabQueue = [tabP]; scriptImpl = () => [{ result: SN[snap] }]; };
const ask = async () => { ids["ask-page-button"].fire("click"); await tick(40); };

(async () => {
  // ===== A. normalizeSnapshot: selection + rejection fields are whitelisted =====
  const hostile = normalizeSnapshot({ title: "t", url: "https://site.test/page", text: "x",
    selection: { mode: "fallback", regionType: "<b>", reason: "candidates-rejected", candidatesFound: 3, candidates: 0, rejected: { notRendered: 2, insideChrome: -4, skipped: "9", littleText: 1 }, excluded: [{ category: "evil", regions: 1 }] },
    headings: [], links: [], navLinks: [], controls: [] });
  ok("A: candidates-rejected reason and counts accepted; bad numbers/types coerced to 0", hostile.selection.reason === "candidates-rejected" && hostile.selection.candidatesFound === 3 && hostile.selection.rejected.notRendered === 2 && hostile.selection.rejected.insideChrome === 0 && hostile.selection.rejected.skipped === 0 && hostile.selection.rejected.littleText === 1 && hostile.selection.regionType === "none" && hostile.selection.excluded.length === 0, JSON.stringify(hostile.selection));
  ok("A: unknown reason string -> 'unknown' (never shown raw)", normalizeSnapshot({ title: "", url: "", text: "", selection: { reason: "<script>" }, headings: [], links: [], controls: [] }).selection.reason === "unknown");

  // ===== B. The MDN-shaped page through buildEvidence =====
  let ev = evid("ref_contents_main"); let T = ev.snapshotText;
  ok("B: fits the unchanged 4000-char budget", T.length <= 4000, String(T.length));
  ok("B: SELECTION: primary content region <main>, heuristic wording, NOT 'no main/article'", /SELECTION \(a heuristic guess, not certain\): page text is the PRIMARY CONTENT region, <main>; reason: the best-scoring main region/.test(T) && !/no main or article element/.test(T));
  ok("B: page text is the article's prose, starts with its title", /PAGE TEXT EXCERPT \(ID s1:T; primary content region\):\n<h1>–<h6> HTML section heading elements\nThe <h1> to <h6> HTML elements represent six levels/.test(T));
  ok("B: inline markup survives into the prompt text", T.includes("<h1> is the highest section level and <h6> is the lowest.") && T.includes("Range: h1–h6, and Note: levels must not be skipped."));
  ok("B: nav/skip links/footer/menu text absent from page text; TOC not duplicated", !/Skip to main content|Element-\d|REF_PAGE_FOOTER|Privacy|In this article/.test(textPart(T)));
  ok("B: headings exact incl. <h1>–<h6>, levels as captured, scope stated", /s1:H1 \| h1: "<h1>–<h6> HTML section heading elements"/.test(T) && /s1:H5 \| h3: "Avoid using multiple <h1> elements on one page"/.test(T) && /from the primary region/.test(sectionOf(T, "HEADINGS (actual")));
  ok("B: heading omission explicit with counts", /\[OMITTED: \d+ of 18 headings were captured but are NOT shown here/.test(T) && ev.counts.headings.total === 18);
  ok("B: navigation is its own capped section incl. the TOC", /NAVIGATION LINKS \(site menus, banner, footer and sidebar links; NOT part of the main content/.test(T) && SN.ref_contents_main.navLinks.some((l) => l.label === "Try it") && ev.counts.nav.total === SN.ref_contents_main.navLinks.length);
  const navBlock = sectionOf(T, "NAVIGATION LINKS ("); const textLen = textPart(T).length;
  ok("B: navigation uses far less room than the page text", navBlock.length < textLen / 2, `nav ${navBlock.length}, text ${textLen}`);
  ok("B: ids scoped to the snapshot; sent flags honest", [...ev.records.keys()].every((k) => /^s1:(?:[HLNC]\d+|T)$/.test(k)) && ev.records.get("s1:H1").sent === true && ev.records.get("s1:H18").sent === false);
  ok("B: shown records are whole (no half-cut line or URL)", T.split("\n").filter((l) => /^s1:[LN]\d+ \|/.test(l)).every((l) => /-> (https:\/\/\S+|\(.*\))$/.test(l)) && T.split("\n").filter((l) => /^s1:H\d+ \|/.test(l)).every((l) => /^s1:H\d+ \| h[1-6]: ".*"$/.test(l)));

  // ===== C. Rejection reporting in the model-facing note =====
  T = evid("rej_hidden_main").snapshotText;
  ok("C: hidden <main>: note says found-but-rejected (not rendered), reason names rejection", /main\/article elements exist but none was usable/.test(T) && /Note: 1 main\/article element\(s\) were found on the page; some were not used \(not rendered 1\)\./.test(T) && !/has no main or article element/.test(T), sectionOf(T, "SELECTION"));
  ok("C: ...and says fallback honestly", /NO trustworthy primary content region/.test(T) && /WHOLE-PAGE FALLBACK/.test(T) && textPart(T).includes("VISIBLE_APP_TEXT"));
  T = evid("rej_inside_chrome").snapshotText;
  ok("C: article in <nav>: rejected as inside navigation/sidebar", /inside navigation\/banner\/footer\/sidebar 1/.test(T));
  T = evid("rej_little_text").snapshotText;
  ok("C: tiny main: usable but 'too little text'", /its usable main\/article regions held too little text/.test(T) && /too little text 1/.test(T));
  T = evid("rej_editable").snapshotText;
  ok("C: editable article: rejected, text never included", /editable or inside skipped content 1/.test(T) && !T.includes("EDITABLE_ARTICLE_TEXT"));
  T = evid("rej_none").snapshotText;
  ok("C: truly no main/article element says exactly that", /the page has no main or article element/.test(T) && !/were found on the page/.test(T));
  T = evid("two_articles").snapshotText;
  ok("C: ambiguous articles: reason named, fallback labelled", /several comparable articles and no main region/.test(T));

  // ===== D. Budget pressure from chrome =====
  T = evid("chrome_pressure").snapshotText;
  ok("D: tiny app + huge nav/footer: content comes first in the excerpt, chrome after", textPart(T).indexOf("APP_CORE_TEXT") < textPart(T).indexOf("Menu-1") && /also includes navigation\/banner\/footer\/sidebar text, because little other text exists/.test(T) && T.length <= 4000);
  ev = evid("primary_pressure"); T = ev.snapshotText;
  ok("D: article + 300-link menu + long footer: article whole, no chrome in text, nav separate and small", /PAGE TEXT EXCERPT \(ID s1:T; primary content region\):\nCore Article/.test(T) && textPart(T).includes("CORE_PARA_2") && !/Menu-|Footer legal/.test(textPart(T)) && /NAVIGATION LINKS/.test(T) && sectionOf(T, "NAVIGATION LINKS (").length < 700, String(sectionOf(T, "NAVIGATION LINKS (").length));
  const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const bigSnap = { ...SN.ref_contents_main, headings: mk(40, (i) => ({ level: (i % 6) + 1, text: `Heading ${i} ` + "w".repeat(60), where: "main" })), headingsCapped: true,
    text: "lorem ipsum ".repeat(300), textTruncated: true,
    links: mk(60, (i) => ({ label: "Link " + i, status: "ok", href: `https://s.test/p/${i}?a=${"b".repeat(60)}&c=${i}` })), linksCapped: true,
    navLinks: mk(60, (i) => ({ label: "Nav " + i, status: "ok", href: `https://s.test/n/${i}?q=${"z".repeat(50)}`, region: ["navigation", "banner", "footer", "complementary"][i % 4] })), navLinksCapped: true,
    controls: mk(40, (i) => ({ kind: "button", label: "Button " + i })), controlsCapped: true, iframeCount: 3 };
  ev = buildEvidence(normalizeSnapshot(bigSnap), "s9", 4000); T = ev.snapshotText;
  ok("D: worst case (every section overfull) fits 4000", T.length <= 4000, String(T.length));
  ok("D: every shown record whole; each section states omissions", T.split("\n").filter((l) => /^s9:L\d+ \|/.test(l)).every((l) => /^s9:L\d+ \| "Link \d+" -> https:\/\/s\.test\/p\/(\d+)\?a=b{60}&c=\1$/.test(l)) && T.split("\n").filter((l) => /^s9:N\d+ \|/.test(l)).every((l) => /^s9:N\d+ \| [a-z\/ ]+: "Nav \d+" -> https:\/\/s\.test\/n\/\d+\?q=z{50}$/.test(l)) && ["headings", "links", "navigation links", "controls"].every((n) => new RegExp(`\\[OMITTED: \\d+ of \\d+ ${n} `).test(T)) && /TEXT CUT OFF/.test(T));
  ok("D: page text still gets real room next to nav (text > nav)", textPart(T).length > sectionOf(T, "NAVIGATION LINKS (").length);

  // ===== E. The complete request: ordered instructions, no conflicts =====
  fresh("List at most three actual headings from this snapshot, with their levels."); fetchImpl = () => reply({ status: "answered", answer: "x", citations: [] });
  await ask();
  const b = fetchCalls[0].body; const sys = b.system;
  ok("E: request contract unchanged: model, stream, think, format, no num_ctx/options", b.model === "qwen3:4b-instruct" && b.stream === false && b.think === false && JSON.stringify(b.format) === JSON.stringify(REPLY_SCHEMA) && JSON.stringify(Object.keys(b).sort()) === '["format","model","prompt","stream","system","think"]' && !("options" in b));
  const iLimit = sys.indexOf("Counts and limits"), iList = sys.indexOf("If the question states no limit and asks for a list");
  ok("E: explicit limits are stated BEFORE, and override, the list-everything rule", iLimit >= 0 && iList > iLimit && /It overrides every completeness rule below/.test(sys));
  ok("E: the list-everything rule applies only when no limit is stated (no unconditional 'include every match')", !/\n- For list questions \(all headings/.test(sys) && /states no limit/.test(sys));
  ok("E: at most / exactly semantics, no padding, cite only what is listed", /At most N. means N or fewer/.test(sys) && /Exactly N. means N only if the snapshot supports N items/.test(sys) && /Never invent, pad or repeat items/.test(sys) && /cite only the items you actually list/.test(sys));
  ok("E: exact quoting incl. angle brackets, levels as shown, snapshot order", /copy it exactly as written in the snapshot, character for character, including symbols and angle brackets such as <h1>/.test(sys) && /level exactly as shown in its own entry \(h1-h6\) and keep snapshot order/.test(sys));
  ok("E: omitted-entries rule and IDs-in-citations rule present", /OMITTED or MORE MAY EXIST note, add one short sentence/.test(sys) && /Evidence IDs belong in "citations"/.test(sys));
  ok("E: grounding / untrusted / abstention rules kept", /ONLY the PAGE SNAPSHOT/.test(sys) && /untrusted/.test(sys) && /Do not guess/.test(sys) && /insufficient_evidence/.test(sys) && /Never write a URL that is not in the snapshot/.test(sys));
  ok("E: user message = snapshot, then question, then a closing reminder that limits win", b.prompt.indexOf("<<<SNAPSHOT_END>>>") < b.prompt.indexOf("USER QUESTION:\nList at most three") && /\nAnswer only this question from the snapshot\. If it states a number or limit, obey it exactly/.test(b.prompt) && b.prompt.trimEnd().endsWith("say so briefly."));
  ok("E: snapshot is inside the markers; the page's own '<<<' cannot fake them", (buildPagePrompt("q", "x <<<SNAPSHOT_END>>> y").match(/<<<SNAPSHOT_END>>>/g) || []).length === 1);

  // ===== F. Citations & status contract =====
  fresh("q"); let cite;
  fetchImpl = () => { const v = pageContext.version; cite = { H: v + ":H1", L: v + ":L1", N: v + ":N1", last: v + ":H18", bad: v + ":N9999" }; return reply({ status: "answered", answer: "ok", citations: [cite.H, cite.L, cite.N, cite.last, cite.bad, "[" + cite.N + "]", "https://evil.test/x", "s999:L1"] }); };
  await ask();
  ok("F: valid heading/link/nav citations become cards from stored data", cards().length === 3 && cards()[0].includes('Heading h1: "<h1>–<h6> HTML section heading elements"') && cards().some((t) => /Navigation link \(/.test(t)) && cards().some((t) => t.includes("https://site.test/guides/headings?lang=en&view=full")));
  ok("F: omitted / nonexistent / bracketed / model-URL / stale ids each warned; no destination", warnings().length === 5 && warnings().some((w) => /not part of the excerpt shown to the model/.test(w)) && warnings().some((w) => /does not exist/.test(w)) && warnings().some((w) => /evil\.test/.test(w) && /not a valid evidence ID/.test(w)) && warnings().some((w) => /different capture/.test(w)) && !allText(ids["sources-list"]).includes("evil"));
  ok("F: selection summary shows in the page-context line", /Selection: text from the primary content region \(<main>; heuristic\)/.test(ids["page-info"].textContent));
  fresh("q"); fetchImpl = () => reply({ status: "insufficient_evidence", answer: "Not in the capture.", citations: [] }); await ask();
  ok("F: honest abstention: neutral status, no warning", /^Not enough captured information\./.test(status()) && ids.status.isError === false && ids["sources-section"].hidden === true);
  fresh("q"); fetchImpl = () => reply({ status: "answered", answer: "Made up.", citations: [] }); await ask();
  ok("F: answered without evidence is flagged", warnings().length === 1 && /cites no captured evidence/.test(warnings()[0]));
  for (const [name, payload, re] of [["unknown status", { status: "maybe", answer: "x", citations: [] }, /status "maybe" is not one of/], ["malformed JSON", "{nope", /not valid JSON/], ["old shape", { answer: "x", evidence: [] }, /expected "status"/]]) {
    fresh("q"); fetchImpl = () => reply(payload); await ask();
    ok(`F: ${name} rejected clearly`, ids.status.isError === true && /was rejected because/.test(status()) && re.test(status()) && ids["sources-section"].hidden === true);
  }

  // ===== G. Capture failures, cancellation, stale protection =====
  const before = snapshotCounter;
  fresh("q"); tabQueue = [tabP, { id: 8, url: "https://other.test/" }]; await ask();
  ok("G: tab changed during capture: discarded, no request, no version used", /changed or navigated/.test(status()) && fetchCalls.length === 0 && snapshotCounter === before);
  fresh("q", "chrome_only"); fetchImpl = () => reply({ status: "answered", answer: "ok", citations: [] }); await ask();
  ok("G: a menu-only page is not 'empty'", fetchCalls.length === 1 && /Section-3/.test(fetchCalls[0].body.prompt));
  fresh("q"); let rel; scriptImpl = () => new Promise((res) => (rel = () => res([{ result: SN.ref_contents_main }])));
  ids["ask-page-button"].fire("click"); await tick(30); ids["ask-page-button"].fire("click"); ids["prompt-form"].fire("submit", { preventDefault() {} });
  ok("G: Send/Ask blocked while capturing; Stop available", ids["send-button"].disabled && ids["ask-page-button"].disabled && !ids["stop-button"].disabled);
  ids["stop-button"].fire("click"); rel(); await tick(40);
  ok("G: Stop during capture: nothing sent, no context, controls back", /Cancelled before anything was sent/.test(status()) && fetchCalls.length === 0 && pageContext === null && !ids["send-button"].disabled);
  fresh("q"); fetchImpl = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))));
  ids["ask-page-button"].fire("click"); await tick(40); ids["stop-button"].fire("click"); await tick(30);
  ok("G: Stop during the request: cancelled, nothing rendered", /may still be computing/.test(status()) && ids.reply.textContent === "" && ids["sources-section"].hidden === true);
  fresh("q"); ids["ask-page-button"].fire("click"); await tick(300);
  ok("G: timeout unchanged", /Timed out/.test(status()) && !ids["send-button"].disabled);
  fetchCalls = []; let resolveA; const slowA = new Promise((res) => (resolveA = res));
  fetchImpl = () => (fetchCalls.length === 1 ? slowA : reply({ status: "insufficient_evidence", answer: "NEW", citations: [] }));
  const pA = runRequest("A", async () => ({ prompt: "old", structured: true, version: "s1", format: REPLY_SCHEMA }));
  await tick(10);
  await runRequest("B", async () => ({ prompt: "new", structured: true, version: "s1", format: REPLY_SCHEMA }));
  resolveA(await reply({ status: "answered", answer: "OLD", citations: ["s1:N1"] })); await pA; await tick();
  ok("G: stale reply cannot overwrite the newer reply, status or sources", ids.reply.textContent === "NEW" && /^Not enough captured information\./.test(status()) && ids["sources-section"].hidden === true && !ids["send-button"].disabled);
  fresh("q"); let rel2; fetchImpl = () => new Promise((res) => (rel2 = () => res(reply({ status: "answered", answer: "late", citations: [pageContext ? pageContext.version + ":N1" : "s1:N1"] }))));
  ids["ask-page-button"].fire("click"); await tick(40); handlers.activated({ tabId: 99 }); rel2(); await tick(40);
  ok("G: capture cleared before the answer: citations unchecked, no destination shown", ids.reply.textContent === "late" && /could not be checked/.test(status()) && cards().length === 0 && !/https:\/\//.test(allText(ids["sources-list"])));
  fresh("say ready"); fetchImpl = () => reply("ready"); ids["prompt-form"].fire("submit", { preventDefault() {} }); await tick();
  ok("G: plain chat untouched (no capture, system, format or reminder)", scriptCalls.length === 0 && !("format" in fetchCalls[0].body) && !("system" in fetchCalls[0].body) && fetchCalls[0].body.prompt === "say ready" && status() === "Done.");

  // ===== H. Privacy through to the model prompt =====
  T = evid("privacy").snapshotText;
  const leaks = ["HIDDEN_DISPLAY_TEXT", "HIDDEN_VIS_TEXT", "HIDDEN_ATTR_TEXT", "SCRIPT_SECRET", "NOSCRIPT_TEXT", "PASSWORD_SECRET", "TYPED_SECRET", "TEXTAREA_SECRET", "OPTION_TEXT", "EDITABLE_SECRET", "IFRAME_SECRET", "SVG_TEXT", "SECRETTOKEN123", "NAVSECRET123", "FOOTSECRET", "FOOTER_PRIV_TEXT"];
  ok("H: nothing hidden, typed, editable or secret reaches the prompt", leaks.every((x) => !T.includes(x)), leaks.filter((x) => T.includes(x)).join(","));
  ok("H: tokened links are withheld in content, nav and footer; functional query kept", (T.match(/destination withheld as possibly credential-bearing; unavailable/g) || []).length === 3 && /"Functional query link" -> https:\/\/site\.test\/search\?q=hello\+world&page=2/.test(T));

  // ===== I. Hygiene =====
  const strip = (f) => fs.readFileSync(path.join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const code = strip("sidepanel.js") + strip("capture.js");
  ok("I: no site-specific names anywhere in the code", !/mdn|mozilla|wikipedia|example\.com|#content\b|\.sidebar|\.layout/i.test(code));
  ok("I: the extractor never looks at class names, ids or page keywords", !/getElementsByClassName|\.className|classList|\.id\b\s*[=!]==?|\[class|\[id|cookie|consent|navbar/i.test(strip("capture.js")));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  ok("I: permissions unchanged", JSON.stringify(manifest.permissions) === '["sidePanel","activeTab","scripting"]' && JSON.stringify(manifest.host_permissions) === '["http://localhost:11434/*"]');
  ok("I: budget, model, timeout, question limit unchanged; no num_ctx", SNAPSHOT_BUDGET_CHARS === 4000 && MODEL === "qwen3:4b-instruct" && TIMEOUT_MS === 180000 && MAX_QUESTION_CHARS === 500 && !/num_ctx|options\s*:/.test(code));
  ok("I: ID pattern still H/L/N/C/T only", ID_PATTERN.test("s1:N3") && ID_PATTERN.test("s1:T") && !ID_PATTERN.test("s1:X1"));

  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  fs.writeFileSync(path.join(out, "panel_result.txt"), results.join("\n") + `\n\nFAILS: ${fails} of ${results.length}`);
  console.log(results.join("\n") + `\n\npanel tests: ${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH " + e.stack + "\n\n" + results.join("\n")); process.exit(1); });

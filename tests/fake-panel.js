// A fake browser around the REAL sidepanel.js, for testing the whole path from a
// raw Ollama reply to what the panel displays. Fake DOM, fake chrome.* API, fake
// fetch (or the real local Ollama with { live: true }). Not the installed extension.
//   const panel = require("./fake-panel.js").load();
//   panel.useCapture("ref_contents_main");   // a capture from tests/.out/
//   await panel.ask("question", reply);       // reply: object or string the "model" returns
//   panel.view() -> { reply, status, isError, listed, cards, warnings, ... }
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, ".out");
const root = path.join(__dirname, "..");

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

const ELEMENT_IDS = ["prompt-form", "prompt-input", "send-button", "stop-button", "ask-page-button", "status", "reply", "page-info", "excerpt-details", "excerpt", "sources-section", "sources-note", "entries-heading", "entries-list", "other-sources-heading", "sources-list", "sources-warnings"];

function load(options = {}) {
  const ids = {};
  for (const i of ELEMENT_IDS) ids[i] = new FakeEl(i);
  global.document = { getElementById: (i) => ids[i] || (ids[i] = new FakeEl(i)), createElement: (t) => new FakeEl(t) };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
  const handlers = {};
  let tabQueue = [];
  let scriptImpl = () => [];
  global.chrome = {
    tabs: { query: async () => { const t = tabQueue.length > 1 ? tabQueue.shift() : tabQueue[0]; return t ? [t] : []; },
      onActivated: { addListener: (f) => (handlers.activated = f) }, onUpdated: { addListener: (f) => (handlers.updated = f) }, onRemoved: { addListener: (f) => (handlers.removed = f) } },
    scripting: { executeScript: async (o) => scriptImpl(o) },
  };
  const state = { fetchCalls: [], fetchImpl: null };
  const realFetch = global.fetch;
  global.fetch = (url, opts) => { state.fetchCalls.push({ url, body: JSON.parse(opts.body), signal: opts.signal }); return state.fetchImpl(url, opts); };
  if (options.live) state.fetchImpl = (url, opts) => realFetch(url, opts); // real local Ollama
  const realST = setTimeout;
  if (!options.live) global.setTimeout = (f, ms) => (ms === 180000 ? realST(f, 120) : realST(f, ms));

  const names = "ID_PATTERN,MAX_CITED,MAX_REPLY_IDS,parseStructuredReply,resolveCitations,renderSources,buildEvidence,buildPagePrompt,normalizeSnapshot,runRequest,REPLY_SCHEMA,PAGE_SYSTEM_PROMPT,MODEL,OLLAMA_URL,SNAPSHOT_BUDGET_CHARS,TIMEOUT_MS,MAX_QUESTION_CHARS".split(",");
  const src = fs.readFileSync(process.env.SIDEPANEL_SRC || path.join(root, "sidepanel.js"), "utf8").replace(/^const /gm, "var ").replace(/^let /gm, "var ");
  const factory = new Function("capturePageSnapshot", src + `\nreturn { ${names.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ")}, getPageContext: () => pageContext, getSnapshotCounter: () => snapshotCounter };`);
  const capFn = new Function(fs.readFileSync(path.join(root, "capture.js"), "utf8") + "\nreturn capturePageSnapshot;")();
  const api = factory(capFn);

  const tick = (ms = 25) => new Promise((r) => realST(r, ms));
  const tabA = { id: 7, url: "https://site.test/page?x=1" };
  const snaps = {};
  const snap = (name) => (snaps[name] ||= { ...JSON.parse(fs.readFileSync(path.join(out, `snap_${name}.json`), "utf8")), url: "https://site.test/page", readyState: "complete" });
  const responseOf = (r) => ({ ok: true, json: async () => ({ response: typeof r === "string" ? r : JSON.stringify(r), prompt_eval_count: 900, total_duration: 2e9 }) });

  const panel = {
    ids, api, tick, handlers, state, snap,
    useCapture(name) { tabQueue = [tabA]; scriptImpl = () => [{ result: snap(name) }]; },
    useSnapshotObject(obj) { tabQueue = [tabA]; scriptImpl = () => [{ result: obj }]; },
    setTabs(list) { tabQueue = list; },
    setScript(fn) { scriptImpl = fn; },
    reply(r) { state.fetchImpl = async () => responseOf(r); },
    // Compute the reply from the live snapshot version/context (so IDs are valid).
    replyWith(fn) { state.fetchImpl = async () => responseOf(fn(api.getPageContext() ? api.getPageContext().version : "s?", api.getPageContext())); },
    async ask(question, replyObj) {
      state.fetchCalls = [];
      ids["prompt-input"].value = question;
      if (replyObj !== undefined) panel.reply(replyObj);
      ids["ask-page-button"].fire("click");
      await tick(60);
      // With the real model, wait until the panel finishes (Stop is disabled again).
      for (let w = 0; options.live && w < 600 && ids["stop-button"].disabled === false; w++) await tick(500);
    },
    view() {
      const kids = (el) => el.children.map((c) => c.textContent);
      return {
        reply: ids.reply.textContent, status: ids.status.textContent, isError: ids.status.isError,
        sourcesHidden: ids["sources-section"].hidden, note: ids["sources-note"].textContent,
        listed: kids(ids["entries-list"]), listedHeadingHidden: ids["entries-heading"].hidden,
        cards: kids(ids["sources-list"]), warnings: kids(ids["sources-warnings"]),
        listedEls: ids["entries-list"].children, cardEls: ids["sources-list"].children,
        all: [ids["entries-list"], ids["sources-list"], ids["sources-warnings"], ids["sources-note"]].map((e) => { let s = ""; e.walk((n) => (s += n._text + "|")); return s; }).join(""),
      };
    },
  };
  return panel;
}

module.exports = { load, FakeEl };

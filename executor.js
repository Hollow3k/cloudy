// executor.js - runs INSIDE the web page, in the extension's isolated world, ONLY
// when the user has pressed Approve on one proposal. It is the only file in
// Cloudy that clicks, types or scrolls, and it does exactly ONE action per call.
//
// sidepanel.js passes performApprovedAction to chrome.scripting.executeScript
// (main frame, isolated world: no new permission). The panel has already read
// the page again and re-checked the proposal; this function checks again, in the
// same synchronous step as the action, so nothing can change in between:
//  - same document (performance.timeOrigin), same element (the identity KEY that
//    targets.js assigned, not the capture's E-number), still connected, still
//    rendered, same signature (kind, name, state, place in the page) - otherwise
//    it refuses. It never picks a different element.
//  - disabled, read-only, credential/payment-looking, unsupported kind, offscreen,
//    or a javascript: link: refused.
//
// Typing never READS the field: no previous value, no placeholder-as-value, no
// read-back. It selects the field's content (without looking at it) and inserts
// the approved text the way typing does (an `input` event, so frameworks see it).
// It never presses Enter and never submits the form.
//
// Scrolling moves only the page's own scroller, by a bounded step, after checking
// how far it can still go in that direction. Not nested scroll containers.
//
// These are script-made (untrusted) events, not real input: some sites ignore
// them. The result says what was dispatched; it never says the goal was met.

function performApprovedAction(spec) {
  const CLICK_KINDS = ["link", "button", "checkbox", "radio", "disclosure"];
  const TYPE_KINDS = ["text-field", "text-area"];
  const fail = (code, reason) => ({ ok: false, code, reason });

  if (!spec || typeof spec !== "object") return fail("bad-request", "The request was malformed.");
  if (spec.action !== "click" && spec.action !== "type" && spec.action !== "scroll") {
    return fail("bad-request", "Only click, type and scroll can be performed.");
  }
  if (String(performance.timeOrigin) !== spec.token) {
    return fail("document-changed", "The page was reloaded or replaced since the proposal was made.");
  }

  if (spec.action === "scroll") {
    if (spec.direction !== "up" && spec.direction !== "down") return fail("bad-request", "Scroll needs a direction of up or down.");
    const root = document.scrollingElement || document.documentElement;
    const maxTop = Math.max(0, Math.round(root.scrollHeight - window.innerHeight));
    const before = window.scrollY;
    const remaining = spec.direction === "down" ? maxTop - before : before;
    if (!(remaining >= 1)) {
      return fail("cannot-scroll", spec.direction === "down" ? "The page is already at the bottom." : "The page is already at the top.");
    }
    const requested = Math.min(Math.max(1, Math.floor(spec.step) || 1), 2000); // bounded here too
    const step = Math.min(requested, Math.floor(remaining));
    window.scrollBy({ top: spec.direction === "down" ? step : -step, left: 0, behavior: "instant" });
    const after = window.scrollY;
    const moved = Math.round(Math.abs(after - before));
    if (moved < 1) return fail("scroll-blocked", "The page did not move (it may not allow scrolling).");
    return { ok: true, action: "scroll", direction: spec.direction, before: Math.round(before), after: Math.round(after), moved, max: maxTop };
  }

  // click / type: find the SAME element, not a look-alike.
  const world = globalThis.__cloudyTargets;
  if (!world || world.token !== spec.token || typeof world.describe !== "function") {
    return fail("not-captured", "The page has not been captured in this document, so the control cannot be identified.");
  }
  const ref = Number.isInteger(spec.key) ? world.byKey.get(spec.key) : undefined;
  const el = ref ? ref.deref() : undefined;
  if (!el || !el.isConnected) return fail("missing", "The control is no longer on the page.");
  const cur = world.describe(el);
  if (cur === null) return fail("hidden", "The control is hidden or no longer a listed control.");
  if (cur.signature !== spec.signature || cur.kind !== spec.kind) {
    return fail("changed", "The control changed (its name, state or place in the page differs from the one you approved).");
  }
  if (cur.disabled) return fail("disabled", "The control is disabled.");
  if (cur.sensitive) return fail("blocked", "The control looks like a credential or payment field.");
  if (cur.viewport !== "in-view" && cur.viewport !== "partly-in-view") {
    return fail("offscreen", "The control is not in view. Scroll first (that needs its own approval).");
  }

  if (spec.action === "click") {
    if (!CLICK_KINDS.includes(cur.kind)) return fail("blocked", "This kind of control cannot be clicked here.");
    if (el.localName === "a" && /^\s*javascript:/i.test(el.getAttribute("href") || "")) {
      return fail("blocked", "This link runs script (a javascript: address), so it is not clicked.");
    }
    el.click();
    return { ok: true, action: "click", kind: cur.kind };
  }

  // type
  if (!TYPE_KINDS.includes(cur.kind)) return fail("blocked", "Text can only be typed into a text field or text area.");
  if (cur.readOnly) return fail("readonly", "The field is read-only.");
  if (typeof spec.text !== "string" || spec.text === "" || spec.text.length > 200 || /[\u0000-\u001f\u007f]/.test(spec.text)) {
    return fail("bad-request", "The text to type is empty, too long or contains control characters.");
  }
  el.focus({ preventScroll: true });
  let method = "insertText";
  let inserted = false;
  try {
    el.select(); // selects whatever is there, without reading it
    inserted = document.execCommand("insertText", false, spec.text);
  } catch (_) {
    inserted = false;
  }
  if (!inserted) {
    // Same effect for fields where insertText is unavailable: the browser's own
    // setter (what frameworks listen to), then the events a person's typing causes.
    method = "setter";
    const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, spec.text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: spec.text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { ok: true, action: "type", kind: cur.kind, method };
}

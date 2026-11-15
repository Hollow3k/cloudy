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
// Typing never READS the field: no previous value, no read-back. It selects the
// field's content (without looking at it) and inserts the approved text the way
// typing does (an `input` event, so frameworks see it). It never presses Enter and
// never submits the form: "type" only fills.
//
// A SEARCH is one approved operation with a fixed sequence: fill the search field
// (skipped when it already holds exactly the query), then submit it by clicking the
// associated search control, or by form.requestSubmit() on an identified search
// form (native validation and the site's own handling apply). Never form.submit(),
// never a synthetic Enter, never another form. It reads the field's value (an
// ordinary, non-secret field, already verified) only to compare with the approved
// initial state and to check the expected new state after filling. If anything
// differs it stops and reports what was already done (a partial run).
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
  if (spec.action !== "click" && spec.action !== "type" && spec.action !== "search" && spec.action !== "scroll") {
    return fail("bad-request", "Only click, type, search and scroll can be performed.");
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
  // The same element (by its key) AND the same control. A task on a page that keeps changing around the control
  // (lazy-loaded lists, ads) compares what the control IS (kind, name, state), not its exact place in the DOM.
  const sameTarget = (c) => spec.loose === true
    ? c.kind === spec.kind && c.name === spec.name && c.disabled === spec.disabled && c.readOnly === spec.readOnly && c.submit === spec.isSubmit
    : c.signature === spec.signature && c.kind === spec.kind;
  if (!sameTarget(cur)) {
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

  const badText = typeof spec.text !== "string" || spec.text === "" || spec.text.length > 200 || /[\u0000-\u001f\u007f]/.test(spec.text);

  // Replace the field's content with `text` the way typing does (an input event), without reading it.
  const fill = (target, text) => {
    target.focus({ preventScroll: true });
    let method = "insertText";
    let inserted = false;
    try {
      target.select(); // selects whatever is there, without reading it
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) {
      // Same effect for fields where insertText is unavailable: the browser's own
      // setter (what frameworks listen to), then the events a person's typing causes.
      method = "setter";
      const proto = target.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, text);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return method;
  };

  if (spec.action === "search") {
    // ONE operation, approved once: fill the search field (unless it already holds exactly the query),
    // then submit it through the path that was resolved and shown before approval. Every step is
    // re-checked against what was approved; on any surprise it stops and says what was already done.
    if (cur.kind !== "text-field") return fail("blocked", "A search needs a text field.");
    if (cur.readOnly) return fail("readonly", "The field is read-only.");
    if (badText) return fail("bad-request", "The query is empty, too long or contains control characters.");
    const w = spec.submit;
    const samePath = (s) => !!s && s.field === true && !!w && s.via === w.via && s.formKey === w.formKey &&
      (w.via === "form" || (w.via === "control" && !!s.submit && s.submit.key === w.key && s.submit.signature === w.signature));
    if (!w || (w.via !== "control" && w.via !== "form")) return fail("blocked", "There is no supported way to submit this search.");
    if (!samePath(cur.search)) return fail("changed", "The way to submit the search differs from the one you approved.");

    // Find what will submit it BEFORE touching the field.
    const findSubmitter = (now) => {
      if (w.via === "control") {
        const ref2 = world.byKey.get(w.key);
        const ctrl = ref2 ? ref2.deref() : undefined;
        if (!ctrl || !ctrl.isConnected) return { error: "The search button is no longer on the page." };
        const d = world.describe(ctrl);
        if (d === null || d.disabled || d.signature !== w.signature) return { error: "The search button changed, is disabled or is hidden." };
        if (el.form && ctrl.form !== el.form) return { error: "The search button no longer belongs to the search form." };
        return { ctrl };
      }
      const form = el.form;
      if (!form || world.keys.get(form) !== w.formKey || !now.search || now.search.via !== "form") return { error: "The search form is no longer the one that was approved." };
      return { form };
    };
    const first = findSubmitter(cur);
    if (first.error) return fail("changed", first.error);

    // The state the proposal was made against. Anything else means the page or the person changed it.
    const before = el.value;
    if (typeof spec.initialValue !== "string" || before !== spec.initialValue) {
      return fail("field-changed", "The search box content changed since the proposal. Nothing was done.");
    }
    const steps = [];
    if (before === spec.text) {
      steps.push({ step: "fill", done: false, skipped: true });
    } else {
      const method = fill(el, spec.text);
      // Check against the EXPECTED NEW state, not the old value.
      if (el.value !== spec.text) {
        return { ok: false, partial: true, code: "unexpected-value", steps: [{ step: "fill", done: true, method }, { step: "submit", done: false }],
          reason: "The field was filled, but it does not hold exactly the query now (the page may have changed it), so the search was not submitted." };
      }
      steps.push({ step: "fill", done: true, method });
    }
    // The page may have reacted to the typing: look again before submitting.
    const now = world.describe(el);
    if (now === null || !sameTarget(now) || !samePath(now.search)) {
      return { ok: false, partial: true, code: "changed-after-fill", steps: [...steps, { step: "submit", done: false }],
        reason: "The page changed after the field was filled (the search box or its submit path differs), so the search was not submitted." };
    }
    const second = findSubmitter(now);
    if (second.error) {
      return { ok: false, partial: true, code: "changed-after-fill", steps: [...steps, { step: "submit", done: false }], reason: `${second.error} The search was not submitted.` };
    }
    if (second.ctrl) second.ctrl.click();
    else second.form.requestSubmit(); // native validation and the site's own submit handling apply
    steps.push({ step: "submit", done: true, via: w.via });
    return { ok: true, action: "search", steps };
  }

  // type: fills only. Nothing here submits, presses Enter or looks at the previous value.
  if (!TYPE_KINDS.includes(cur.kind)) return fail("blocked", "Text can only be typed into a text field or text area.");
  if (cur.readOnly) return fail("readonly", "The field is read-only.");
  if (badText) return fail("bad-request", "The text to type is empty, too long or contains control characters.");
  const method = fill(el, spec.text);
  return { ok: true, action: "type", kind: cur.kind, method };
}

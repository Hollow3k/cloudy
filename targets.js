// targets.js - runs INSIDE the web page (like capture.js). READ-ONLY.
//
// sidepanel.js passes captureActionTargets to chrome.scripting.executeScript in
// the page's isolated world, main frame only. It lists the visible controls a
// person could act on: links, buttons and a supported set of form controls. It
// is separate from capture.js on purpose: the Q&A capture picks the article
// region, but a search box or a menu usually lives OUTSIDE the article, so this
// scans the whole main frame.
//
// It never changes the page, clicks, types, scrolls or follows a link.
//
// Privacy rules (the same spirit as capture.js, stricter for form controls):
//  - It never reads .value (or the value attribute) of ANY input, textarea or
//    select, never reads contenteditable text, never reads autofill contents,
//    and never checks whether a field is empty. Names come only from
//    author-written markup: aria-labelledby, aria-label, <label>, visible text
//    of buttons/links, img alt, svg <title>, the title attribute, and (flagged
//    as weak) the placeholder.
//  - Hidden controls are left out and only counted.
//  - Password fields, file pickers, select menus, other input types and
//    contenteditable regions are listed by safe metadata but marked
//    UNSUPPORTED; the panel will not accept a proposal that targets them.
//  - Link destinations are not returned. Each target carries a short hash
//    ("signature") so the panel can notice that the page changed.
//
// This is a SUPPORTED SUBSET of the accessible-name computation, not a
// complete accessibility-tree implementation. It does not enter iframes or
// shadow roots, and it does not read canvas content; it reports how many exist.

function captureActionTargets(limits) {
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "head",
    "textarea", "select", "option", "datalist",
    "iframe", "frame", "object", "embed", "canvas", "svg", "math",
  ]);
  const SELECTOR =
    'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [contenteditable]';
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number"]);
  const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
  // Only a yes/no hint is returned; the attribute text itself never leaves the page.
  const SENSITIVE_RE = /pass(word|wd|code)?|pwd|otp|one.?time|2fa|mfa|cvv|cvc|csc|card.?(num|number)|cc.?(num|number|csc|exp)|ssn|social.?security|secret|token|api.?key|\bpin\b/i;
  const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;

  function clip(text, max) {
    return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
  }

  const displayCache = new Map();
  function displayOf(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    return d;
  }

  // display:contents has no box of its own; checkVisibility() calls it hidden
  // although its children are shown, so judge it by its parent (same rule as capture.js).
  function isVisible(el) {
    if (displayOf(el) === "contents") return el.parentElement ? isVisible(el.parentElement) : true;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function isRendered(el) {
    return isVisible(el) && (displayOf(el) === "contents" || el.getClientRects().length > 0);
  }

  // Visible, author-written text under `root`. Never reads form values, textarea
  // or select content, or contenteditable text, and skips aria-hidden parts.
  function safeText(root, maxChars) {
    if (root.isContentEditable || SKIP_TAGS.has(root.localName) || root.localName === "input") return "";
    let out = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.localName) || node.localName === "input" || node.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (node.getAttribute("aria-hidden") === "true" || !isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    let visited = 0;
    while ((node = walker.nextNode())) {
      if (++visited > 400) break;
      const t = node.nodeValue.replace(/\s+/g, " ").trim();
      if (t === "") continue;
      out += (out === "" ? "" : " ") + t;
      if (out.length > maxChars) break;
    }
    return out.slice(0, maxChars);
  }

  function iconLabel(el) {
    const img = el.querySelector("img[alt]");
    if (img && img.getAttribute("alt").trim() !== "") return img.getAttribute("alt").trim();
    const title = el.querySelector("svg > title");
    if (title && title.textContent.trim() !== "") return title.textContent.trim();
    return "";
  }

  // A reference target of aria-labelledby: skip anything a person can type into.
  function referencedText(ref, max) {
    const tag = ref.localName;
    if (ref.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") return "";
    return safeText(ref, max);
  }

  // Supported subset of the accessible-name steps, in this order:
  // aria-labelledby, aria-label, native <label>, (image input alt), content, title, placeholder.
  function accessibleName(el, kind, inputType) {
    const max = limits.nameMax;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = [];
      for (const id of labelledby.split(/\s+/).slice(0, 5)) {
        if (id === "") continue;
        const ref = document.getElementById(id);
        if (ref) {
          const t = referencedText(ref, max);
          if (t !== "") parts.push(t);
        }
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined !== "") return { name: clip(joined, max), source: "aria-labelledby" };
    }
    const ariaLabel = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (ariaLabel !== "") return { name: clip(ariaLabel, max), source: "aria-label" };
    if (el.labels && el.labels.length > 0) {
      const t = Array.from(el.labels).map((l) => safeText(l, max)).join(" ").replace(/\s+/g, " ").trim();
      if (t !== "") return { name: clip(t, max), source: "label" };
    }
    if (el.localName === "input" && inputType === "image") {
      const alt = (el.getAttribute("alt") || "").trim();
      if (alt !== "") return { name: clip(alt, max), source: "alt" };
    }
    if (kind === "link" || kind === "button" || kind === "disclosure" || kind === "checkbox" || kind === "radio") {
      const t = safeText(el, max).replace(/\s+/g, " ").trim();
      if (t !== "") return { name: clip(t, max), source: "content" };
      const icon = iconLabel(el);
      if (icon !== "") return { name: clip(icon, max), source: "alt" };
    }
    const title = (el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    if (title !== "") return { name: clip(title, max), source: "title" };
    if (kind === "text-field" || kind === "text-area") {
      const ph = (el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
      if (ph !== "") return { name: clip(ph, max), source: "placeholder" }; // weak: not a real label
    }
    return { name: "", source: "none" };
  }

  // What kind of control is this? null = not something we list.
  function classify(el) {
    const tag = el.localName;
    const role = (el.getAttribute("role") || "").toLowerCase().split(/\s+/)[0];
    if (el.isContentEditable) {
      if (el.parentElement && el.parentElement.isContentEditable) return null; // inside an editing host
      return { kind: "editable-region" };
    }
    if (tag === "a") return { kind: "link" };
    if (tag === "button") {
      const type = (el.getAttribute("type") || "submit").toLowerCase();
      return { kind: "button", submit: type === "submit" && !!el.form };
    }
    if (tag === "summary") return { kind: "disclosure" };
    if (tag === "select") return { kind: "select-menu" };
    if (tag === "textarea") return { kind: "text-area" };
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return { kind: "hidden-input" };
      if (BUTTON_INPUT_TYPES.has(type)) return { kind: "button", submit: type === "submit" || type === "image", inputType: type };
      if (type === "checkbox") return { kind: "checkbox" };
      if (type === "radio") return { kind: "radio" };
      if (type === "password") return { kind: "password-field" };
      if (type === "file") return { kind: "file-picker" };
      if (TEXT_INPUT_TYPES.has(type)) return { kind: "text-field", inputType: type };
      return { kind: "other-input" };
    }
    if (role === "button") return { kind: "button" };
    if (role === "link") return { kind: "link" };
    if (role === "checkbox") return { kind: "checkbox" };
    if (role === "radio") return { kind: "radio" };
    return null;
  }

  function viewportStatus(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.width === 0 && r.height === 0) return "unknown";
    const inX = r.right > 0 && r.left < vw;
    const inY = r.bottom > 0 && r.top < vh;
    if (inX && inY) {
      return r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw ? "in-view" : "partly-in-view";
    }
    if (!inY) return r.bottom <= 0 ? "above" : "below";
    return r.right <= 0 ? "left" : "right";
  }

  function regionOf(el) {
    let sawForm = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const role = p.getAttribute("role");
      const tag = p.localName;
      if (role === "search" || tag === "search") return "search";
      if (role === "navigation" || tag === "nav") return "navigation";
      if (role === "main" || tag === "main") return "main";
      if (role === "complementary" || tag === "aside") return "sidebar";
      if (role === "dialog" || tag === "dialog") return "dialog";
      if (role === "banner") return "banner";
      if (role === "contentinfo") return "footer";
      if (!role && (tag === "header" || tag === "footer") &&
          !(p.parentElement && p.parentElement.closest('article, aside, main, nav, section, [role="main"], [role="article"]'))) {
        return tag === "header" ? "banner" : "footer";
      }
      if (tag === "form") sawForm = true;
    }
    return sawForm ? "form" : "page";
  }

  function pathOf(el) {
    const parts = [];
    let p = el;
    for (let i = 0; p && p.parentElement && i < 14; i++) {
      let idx = 1;
      for (let s = p.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === p.localName) idx++;
      parts.push(p.localName + idx);
      p = p.parentElement;
    }
    return parts.join(">");
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  const body = document.body;
  const targets = [];
  let hiddenOmitted = 0;
  let capped = false;
  let scanned = 0;
  const signatures = [];

  if (body) {
    const candidates = document.querySelectorAll(SELECTOR);
    const scanLimit = Math.min(candidates.length, limits.scanCap);
    if (candidates.length > scanLimit) capped = true;
    for (let i = 0; i < scanLimit; i++) {
      const el = candidates[i];
      scanned++;
      if (el.closest("template, noscript, head")) continue;
      const cls = classify(el);
      if (cls === null) continue;
      if (cls.kind === "hidden-input" || !isRendered(el)) {
        hiddenOmitted++;
        continue;
      }
      if (targets.length >= limits.maxTargets) {
        capped = true;
        break;
      }
      const kind = cls.kind;
      const editable = kind === "text-field" || kind === "text-area" || kind === "password-field" || kind === "file-picker" || kind === "select-menu" || kind === "other-input";
      const { name, source } = accessibleName(el, kind, cls.inputType || "");
      const disabled = el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" || !!el.closest("[inert]");
      const readOnly = (kind === "text-field" || kind === "text-area") && (el.readOnly === true || el.getAttribute("aria-readonly") === "true");
      const sensitive =
        editable &&
        (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "") ||
          SENSITIVE_RE.test(el.getAttribute("name") || "") ||
          SENSITIVE_RE.test(el.getAttribute("id") || ""));
      const region = regionOf(el);
      const viewport = viewportStatus(el);
      const destHash = kind === "link" && el.href ? hash(String(el.href)) : "";
      const signature = hash([kind, cls.inputType || "", name, source, disabled, readOnly, !!cls.submit, region, pathOf(el), destHash].join("\u0001"));
      signatures.push(signature);
      targets.push({
        n: targets.length + 1,
        kind,
        inputType: cls.inputType || "",
        name,
        nameSource: source,
        disabled,
        readOnly,
        submit: !!cls.submit,
        sensitive,
        viewport,
        region,
        signature,
      });
    }
  }

  // Scope that is NOT covered, reported rather than implied.
  let openShadowRoots = 0;
  let shadowScanCapped = false;
  if (body) {
    const all = document.querySelectorAll("*");
    const n = Math.min(all.length, 20000);
    shadowScanCapped = all.length > n;
    for (let i = 0; i < n; i++) if (all[i].shadowRoot) openShadowRoots++;
  }

  return {
    documentToken: String(performance.timeOrigin), // differs for every new document, even at the same URL
    url: clip(location.protocol + "//" + location.host + location.pathname, limits.urlMax),
    title: clip((document.title || "").replace(/\s+/g, " ").trim(), limits.titleMax),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: {
      top: Math.round(window.scrollY),
      max: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
    },
    targets,
    capped,
    scanned,
    hiddenOmitted,
    fingerprint: hash(signatures.join("|") + "#" + targets.length),
    scope: {
      iframes: document.querySelectorAll("iframe, frame").length,
      openShadowRoots,
      shadowScanCapped,
      canvases: document.querySelectorAll("canvas").length,
    },
  };
}

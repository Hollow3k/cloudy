// capture.js - the function that runs INSIDE the web page.
//
// sidepanel.js passes this function to chrome.scripting.executeScript. Chrome
// converts it to text, runs it in the page's *isolated world* (it can read the
// DOM but cannot see the page's own JavaScript variables), and sends back the
// returned object. Because it is converted to text, it must be completely
// self-contained: it cannot use any variable or function from sidepanel.js.
// Everything it needs arrives through the `limits` argument.
//
// It is READ-ONLY: it never changes the page, clicks, types, scrolls, or
// follows a link.
//
// WHAT IT PICKS, in plain terms
//  1. Find the page's PRIMARY CONTENT region from semantic markup: <main>,
//     role="main", <article>, role="article". Score each candidate by how much
//     visible text it has and how link-heavy that text is. If a candidate
//     contains another one that holds most of its text, the inner one wins
//     (so nested text is never counted twice). Several <main> regions: the
//     best score wins. No <main> and several comparable articles: no region is
//     trustworthy, so we fall back.
//  2. Identify SITE CHROME that is not primary content: navigation, banner
//     (page-level header), footer and complementary sidebars. <header> and
//     <footer> only count when they are page-level; one inside an <article>,
//     <section>, <main>... is part of that content and is kept.
//  3. Page text = the primary region only. Headings, links and controls come
//     from the same region. Links in chrome go to a separate navigation list.
//  4. No trustworthy region: FALLBACK to the whole page, leaving chrome out
//     first, and including it only if almost nothing else exists.
// All of this is heuristic. The returned `selection` object says what was
// chosen and why, using fixed codes and numbers only (never page text).
//
// Privacy rules enforced here:
//  - never reads .value of any field, and never reads textarea or editable text
//  - skips hidden elements, scripts, styles, iframes, canvas and SVG
//  - link destinations are checked HERE, so a withheld destination never
//    leaves the page: only its status ("redacted") is returned
//  - the page address it returns has no query string or fragment (this is
//    separate from link-destination handling, which keeps functional queries)
// This is NOT a complete privacy filter: ordinary visible text can still
// contain personal information, and the credential check below only catches
// obvious cases.

function capturePageSnapshot(limits) {
  // Tags whose contents we never read (names are lowercase localName values).
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "head",
    "textarea", "select", "option", "datalist",
    "iframe", "frame", "object", "embed", "canvas", "svg", "math",
  ]);
  const SKIP_ANCESTORS = "template, noscript, iframe, object, canvas, svg, textarea, select, datalist, head";
  const MAX_NODES_VISITED = 20000; // stop early on enormous pages
  const SCAN_CAP = 800; // most elements examined per kind
  const MAX_CANDIDATES = 60; // most main/article candidates considered
  const DOMINANT_SHARE = 0.6; // an inner region holding this much of its parent wins
  const MIN_COVERAGE = 0.4; // primary text / (primary + other non-chrome text)
  const MAIN_BONUS = 1.15; // <main> beats an equal-scoring <article>
  const LINK_PENALTY = 0.6; // how strongly link density lowers a score
  const NESTED_ASIDE_LINK_DENSITY = 0.6; // an <aside> inside the region this link-heavy counts as navigation

  function clip(text, max) {
    return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
  }

  const displayCache = new Map();
  function displayOf(el) {
    let display = displayCache.get(el);
    if (display === undefined) {
      display = getComputedStyle(el).display;
      displayCache.set(el, display);
    }
    return display;
  }

  function isVisible(el) {
    // `display: contents` means "no box of its own": the children are laid out
    // and painted as if the element were not there. checkVisibility() reports
    // such an element as NOT visible even though everything inside it is shown,
    // which used to make a whole <main> look hidden. Judge it by its parent.
    if (displayOf(el) === "contents") {
      const parent = el.parentElement;
      return parent ? isVisible(parent) : true;
    }
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function isSkipped(el) {
    return SKIP_TAGS.has(el.localName) || el.isContentEditable;
  }

  // Visible, non-editable element that is not inside a skipped container.
  // Only ANCESTORS are checked: a <select> or <textarea> is itself a control
  // we list by label; it is the contents inside it that are never read.
  function isUsable(el) {
    if (el.isContentEditable || !isVisible(el)) return false;
    return !(el.parentElement && el.parentElement.closest(SKIP_ANCESTORS));
  }

  function docOrder(a, b) {
    return a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  // Visible text under `root`, in document order. Text is joined the way the
  // page renders it: whitespace in the DOM is kept as one space, and text nodes
  // separated by inline markup (links, <code>, <strong>...) with no whitespace
  // between them stay joined, so "<code>h1</code>–<code>h6</code>" is "h1–h6"
  // and "(see <a>x</a>)." is "(see x).". A line break is added only where a
  // block-level box or a <br> starts. Stops once more than `maxChars`
  // characters were found. Elements in `skipSet` (and everything inside them)
  // are left out.
  function collectText(root, maxChars, skipSet) {
    let out = "";
    let truncated = false;
    let breakBefore = false; // a block boundary or <br> was crossed
    let spaceBefore = false; // whitespace followed the previous text
    let visited = 0;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // REJECT skips the element AND everything inside it.
            if (isSkipped(node) || !isVisible(node)) return NodeFilter.FILTER_REJECT;
            if (skipSet && skipSet.has(node)) return NodeFilter.FILTER_REJECT;
            const display = displayOf(node);
            if (node.localName === "br" || (!display.startsWith("inline") && display !== "contents")) {
              breakBefore = true;
            }
            return NodeFilter.FILTER_SKIP; // look at its children, not itself
          }
          return NodeFilter.FILTER_ACCEPT; // a text node
        },
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_NODES_VISITED) {
        truncated = true;
        break;
      }
      const raw = node.nodeValue.replace(/\s+/g, " ");
      const core = raw.trim();
      if (core === "") {
        if (raw !== "") spaceBefore = true;
        continue;
      }
      let separator = "";
      if (out !== "") separator = breakBefore ? "\n" : spaceBefore || raw.charCodeAt(0) === 32 ? " " : "";
      out += separator + core;
      breakBefore = false;
      spaceBefore = raw.charCodeAt(raw.length - 1) === 32;
      if (out.length > maxChars) {
        out = out.slice(0, maxChars);
        truncated = true;
        break;
      }
    }
    return { text: out, truncated };
  }

  // How much visible text is under `root`, and how much of it is link text.
  // Counting stops at limits.measureCap (then `capped` is true).
  function measureText(root, skipSet) {
    let len = 0;
    let linkLen = 0;
    let capped = false;
    let visited = 0;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (isSkipped(node) || !isVisible(node)) return NodeFilter.FILTER_REJECT;
            if (skipSet && skipSet.has(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_NODES_VISITED) {
        capped = true;
        break;
      }
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (text === "") continue;
      len += text.length + 1;
      const parent = node.parentElement;
      if (parent && parent.closest("a[href]")) linkLen += text.length + 1;
      if (len > limits.measureCap) {
        capped = true;
        break;
      }
    }
    return { len, linkLen, capped, density: len > 0 ? linkLen / len : 0 };
  }

  // Visible text inside one element (a link, button, label or heading).
  function textOf(el, maxChars) {
    if (isSkipped(el)) return "";
    return collectText(el, maxChars, null).text.replace(/\s+/g, " ").trim();
  }

  function kindOf(el) {
    const tag = el.localName;
    const role = el.getAttribute("role");
    if (tag === "button" || role === "button") return "button";
    if (role === "link") return "custom link control (no destination)";
    if (tag === "summary") return "disclosure";
    if (tag === "select") return "dropdown";
    if (tag === "textarea") return "text area";
    if (tag === "input") {
      const type = el.type || "text";
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "password") return "password field";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio button";
      if (type === "file") return "file picker";
      return type === "text" ? "text field" : type + " field";
    }
    return "control";
  }

  // A human-friendly label. Never uses .value.
  function labelOf(el) {
    const max = limits.labelMax;
    let label = (el.getAttribute("aria-label") || "").trim();
    if (!label && ["a", "button", "summary"].includes(el.localName)) label = textOf(el, max);
    if (!label && el.getAttribute("role")) label = textOf(el, max);
    if (!label && el.labels && el.labels.length > 0) {
      label = Array.from(el.labels).map((l) => textOf(l, max)).join(" ").trim();
    }
    if (!label) label = (el.getAttribute("placeholder") || "").trim();
    if (!label) label = (el.getAttribute("title") || "").trim();
    if (!label && el.localName === "a") {
      const img = el.querySelector("img[alt]");
      if (img) label = img.getAttribute("alt").trim();
    }
    return clip(label.replace(/\s+/g, " "), max);
  }

  // ---- Site chrome: navigation, banner, footer, complementary ---------------
  // Decided from semantic markup only. No class names, ids, positions or
  // keywords are used.
  const PAGE_LEVEL_ONLY = 'article, aside, main, nav, section, [role="main"], [role="article"]';

  function chromeCategory(el) {
    const role = el.getAttribute("role");
    if (role === "navigation") return "navigation";
    if (role === "complementary") return "complementary";
    if (role === "banner") return "banner";
    if (role === "contentinfo") return "footer";
    if (role) return ""; // another explicit role overrides the native meaning
    switch (el.localName) {
      case "nav":
        return "navigation";
      case "aside":
        return "complementary";
      case "header":
        // A header inside an article/section/main is that content's own header.
        return el.parentElement && el.parentElement.closest(PAGE_LEVEL_ONLY) ? "" : "banner";
      case "footer":
        return el.parentElement && el.parentElement.closest(PAGE_LEVEL_ONLY) ? "" : "footer";
      default:
        return "";
    }
  }

  const chromeInfo = new Map(); // every visible chrome element -> its category
  const chromeOuter = []; // outermost chrome elements, in document order
  const chromeOuterSet = new Set();
  (function findChrome() {
    const all = document.querySelectorAll(
      'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"]'
    );
    const scan = Math.min(all.length, 300);
    for (let i = 0; i < scan; i++) {
      const el = all[i];
      const category = chromeCategory(el);
      if (!category || el.isContentEditable || !isVisible(el) || el.closest(SKIP_ANCESTORS)) continue;
      chromeInfo.set(el, category);
    }
    for (const el of chromeInfo.keys()) {
      let nested = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (chromeInfo.has(p)) {
          nested = true;
          break;
        }
      }
      if (!nested) {
        chromeOuter.push(el);
        chromeOuterSet.add(el);
      }
    }
  })();

  // Category of the nearest chrome region around (or equal to) `el`, or "".
  function nearestChrome(el) {
    for (let p = el; p; p = p.parentElement) {
      const category = chromeInfo.get(p);
      if (category) return category;
    }
    return "";
  }

  // ---- Choosing the primary region -------------------------------------------
  const body = document.body;
  const candidateMap = new Map(); // element -> candidate record
  const candidates = []; // usable candidates (rendered, not inside chrome)
  // Every main/article element found, and why some were not used. Counts only;
  // a rejected candidate must never be reported as if it did not exist.
  let candidatesFound = 0;
  const rejected = { notRendered: 0, insideChrome: 0, skipped: 0, littleText: 0 };
  if (body) {
    const found = document.querySelectorAll('main, [role="main"], article, [role="article"]');
    const scan = Math.min(found.length, MAX_CANDIDATES);
    candidatesFound = found.length;
    for (let i = 0; i < scan; i++) {
      const el = found[i];
      if (el.isContentEditable || (el.parentElement && el.parentElement.closest(SKIP_ANCESTORS))) {
        rejected.skipped++;
        continue;
      }
      if (!isVisible(el)) {
        rejected.notRendered++;
        continue;
      }
      if (nearestChrome(el)) {
        rejected.insideChrome++;
        continue;
      }
      const role = el.getAttribute("role");
      const isMain = el.localName === "main" || role === "main";
      const m = measureText(el, null);
      const candidate = {
        el, isMain, len: m.len, density: m.density, capped: m.capped,
        regionType: el.localName === "main" ? "main" : el.localName === "article" ? "article" : role === "main" ? "role=main" : "role=article",
        parent: null, children: [],
      };
      candidateMap.set(el, candidate);
      candidates.push(candidate);
    }
    for (const c of candidates) {
      for (let p = c.el.parentElement; p; p = p.parentElement) {
        if (candidateMap.has(p)) {
          c.parent = candidateMap.get(p);
          c.parent.children.push(c);
          break;
        }
      }
    }
  }

  // If one inner candidate holds most of its parent's text, use the inner one.
  function resolveInner(c) {
    let best = null;
    for (const child of c.children) if (!best || child.len > best.len) best = child;
    if (best && best.len >= limits.minRegionChars && best.len >= DOMINANT_SHARE * c.len) {
      return resolveInner(best);
    }
    return c;
  }
  const score = (r) => r.len * (1 - LINK_PENALTY * Math.min(r.density, 1)) * (r.rootIsMain ? MAIN_BONUS : 1);

  let primary = null; // { el, regionType, len, density, ... }
  let reason = "";
  let refined = false;
  let otherRegions = 0;
  let coverage = -1; // stays -1 when coverage was never measured
  let otherChars = 0;
  const tops = candidates.filter((c) => !c.parent);
  const eligible = [];
  for (const top of tops) {
    const resolved = resolveInner(top);
    if (resolved.len < limits.minRegionChars) {
      rejected.littleText++;
      continue;
    }
    eligible.push({ ...resolved, rootIsMain: top.isMain, top });
  }
  if (candidatesFound === 0) {
    reason = "no-semantic-region"; // nothing to choose from
  } else if (candidates.length === 0) {
    reason = "candidates-rejected"; // found, but none usable (see `rejected`)
  } else if (eligible.length === 0) {
    reason = "too-little-text";
  } else {
    const mains = eligible.filter((r) => r.rootIsMain);
    const pool = (mains.length > 0 ? mains : eligible).slice();
    pool.sort((a, b) => score(b) - score(a) || docOrder(a.el, b.el));
    const best = pool[0];
    const total = pool.reduce((sum, r) => sum + score(r), 0);
    if (mains.length === 0 && pool.length > 1 && score(best) < DOMINANT_SHARE * total) {
      reason = "ambiguous-articles"; // several comparable articles, no <main>
    } else {
      // Is there lots of ordinary content OUTSIDE the chosen region?
      const outside = measureText(body, new Set([...chromeOuterSet, best.el]));
      otherChars = outside.len;
      coverage = best.len / Math.max(1, best.len + outside.len);
      if (coverage < MIN_COVERAGE) {
        reason = "low-coverage";
      } else {
        primary = best;
        refined = best.el !== best.top.el;
        reason = best.rootIsMain ? (refined ? "inner-of-main" : "main-region") : "dominant-article";
        otherRegions = eligible.length - 1;
      }
    }
  }

  // ---- Navigation INSIDE the chosen region ------------------------------------------
  // A <nav> inside the region (a table of contents, "in this article" links) is
  // navigation, not prose, and repeats the headings. A nested <aside> is kept as
  // content (it may be a note or callout) unless it is mostly links. These are
  // taken out of the page text and headings, and their links go to the
  // navigation list instead.
  const innerSkip = new Set();
  if (primary) {
    for (const [el, category] of chromeInfo) {
      if (el === primary.el || !primary.el.contains(el)) continue;
      if (category === "navigation") {
        innerSkip.add(el);
      } else if (category === "complementary") {
        const m = measureText(el, null);
        if (m.len > 0 && m.density >= NESTED_ASIDE_LINK_DENSITY) innerSkip.add(el);
      }
    }
  }
  function inInnerSkip(el) {
    for (let p = el; p && primary && p !== primary.el; p = p.parentElement) {
      if (innerSkip.has(p)) return true;
    }
    return false;
  }
  // Outermost skipped regions only (a <nav> inside a skipped <aside> is one region).
  const innerSkipOuter = [...innerSkip].filter((el) => {
    for (let p = el.parentElement; p && p !== primary.el; p = p.parentElement) if (innerSkip.has(p)) return false;
    return true;
  });
  // Chrome that sits outside the chosen region (or all chrome in fallback mode).
  const outerRegions = chromeOuter.filter((r) => !(primary && primary.el.contains(r)));
  // Every region whose links belong in the navigation list, in document order.
  const navRegions = [...outerRegions, ...innerSkipOuter].sort(docOrder);

  // ---- Page text --------------------------------------------------------------
  let textResult = { text: "", truncated: false };
  let fallbackIncludesChrome = false;
  if (body) {
    if (primary) {
      textResult = collectText(primary.el, limits.textChars, innerSkip);
    } else {
      // Whole-page fallback. Chrome is left out first. Only if that leaves
      // almost nothing (a menu-only or link-hub page) is chrome text added, and
      // it goes AFTER the page text, so it can never push real content out of
      // the budget.
      textResult = collectText(body, limits.textChars, chromeOuterSet);
      if (textResult.text.length < limits.fallbackMinText && chromeOuter.length > 0) {
        let room = limits.textChars - textResult.text.length - 1;
        let extra = "";
        let extraTruncated = false;
        for (const region of chromeOuter) {
          if (room <= 0) {
            extraTruncated = true;
            break;
          }
          const part = collectText(region, room, null);
          if (part.text === "") continue;
          extra += (extra === "" ? "" : "\n") + part.text;
          room -= part.text.length + 1;
          if (part.truncated) extraTruncated = true;
        }
        if (extra !== "") {
          textResult = {
            text: textResult.text === "" ? extra : textResult.text + "\n" + extra,
            truncated: textResult.truncated || extraTruncated,
          };
          fallbackIncludesChrome = true;
        }
      }
    }
  }

  // ---- What was left out of the page text (by category) -------------------------
  const excluded = [];
  const countByCategory = new Map();
  for (const el of [...outerRegions, ...innerSkipOuter]) {
    if (measureText(el, null).len === 0) continue;
    const category = chromeInfo.get(el);
    countByCategory.set(category, (countByCategory.get(category) || 0) + 1);
  }
  for (const category of ["navigation", "banner", "footer", "complementary"]) {
    if (countByCategory.has(category)) excluded.push({ category, regions: countByCategory.get(category) });
  }

  // ---- Headings: real h1-h6 elements only ----------------------------------------
  // In the region: all of them. Outside it: only level-1 headings that are not
  // inside navigation/footer/sidebar (a page title can live in a page-level
  // header). In fallback mode: everything outside chrome. Nothing is inferred
  // from the title, font size, bold text or ARIA roles.
  function collectHeadings() {
    const els = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const items = [];
    let capped = false;
    let outsideScope = 0;
    let outsideH1 = 0;
    const scan = Math.min(els.length, SCAN_CAP);
    for (let i = 0; i < scan; i++) {
      const el = els[i];
      if (!isUsable(el)) continue;
      const text = textOf(el, limits.headingMax + 1);
      if (text === "") continue; // an empty heading is not evidence of anything
      const level = Number(el.localName.charAt(1));
      const chrome = nearestChrome(el);
      let where = "";
      if (primary && primary.el.contains(el)) {
        where = inInnerSkip(el) ? "" : "main"; // "In this article" style headings are navigation
      } else if (!primary && !chrome) {
        where = "page";
      } else if (level === 1 && (!chrome || chrome === "banner") && outsideH1 < limits.outsideH1Max) {
        where = "outside";
        outsideH1++;
      }
      if (where === "") {
        outsideScope++;
        continue;
      }
      if (items.length >= limits.maxHeadings) {
        capped = true;
        break;
      }
      items.push({ level, text: clip(text, limits.headingMax), where });
    }
    if (!capped && els.length > scan) capped = true;
    return { items, capped, outsideScope };
  }

  // ---- Link destinations ---------------------------------------------------------
  // Why this check lives here: a withheld destination must never be sent to
  // the side panel or the model. Only obvious credential/token patterns are
  // caught; it does not detect every sensitive URL.
  const SENSITIVE_PARAM_NAMES =
    /^(access[_-]?token|id[_-]?token|refresh[_-]?token|auth[_-]?token|token|auth|authorization|bearer|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|session|session[_-]?id|sessionid|sid|jwt|signature|sig|otp|credential|private[_-]?key|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature)$/i;
  const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

  function looksOpaque(value, minLength, allowedChars) {
    return (
      value.length >= minLength &&
      allowedChars.test(value) &&
      /[A-Za-z]/.test(value) &&
      /\d/.test(value)
    );
  }

  // Returns a short reason string if the URL looks credential-bearing, else "".
  // The reason never contains any part of the URL.
  function sensitiveReason(url) {
    if (url.username || url.password) return "credentials embedded in the address";
    if (JWT_LIKE.test(url.href)) return "JWT-like value";

    const params = Array.from(url.searchParams.entries());
    if (url.hash.includes("=")) {
      params.push(...Array.from(new URLSearchParams(url.hash.slice(1)).entries()));
    }
    const names = new Set();
    for (const [name, value] of params) {
      names.add(name.toLowerCase());
      if (value !== "" && SENSITIVE_PARAM_NAMES.test(name)) return "token-like parameter name";
      if (looksOpaque(value, 32, /^[A-Za-z0-9_\-+/=.]+$/)) return "opaque token-like value";
    }
    if (names.has("code") && names.has("state")) return "OAuth-style response parameters";

    for (const segment of url.pathname.split("/")) {
      if (looksOpaque(segment, 32, /^[A-Za-z0-9]+$/)) return "opaque token-like path segment";
    }
    return "";
  }

  // Absolute destination from the DOM (element.href is already resolved
  // against the page's base URL). Only http: and https: are accepted. The
  // link is never followed.
  function classifyDestination(el) {
    let url;
    try {
      url = new URL(el.href);
    } catch (_) {
      return { status: "invalid" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // Report only the scheme name, never what follows it (an email address,
      // a javascript: payload...).
      return { status: "unsupported", scheme: clip(url.protocol, 20) };
    }
    const reason = sensitiveReason(url);
    if (reason) return { status: "redacted", reason };
    // Never shorten a URL: a clipped URL would be a different destination.
    if (url.href.length > limits.maxUrlChars) return { status: "too-long", length: url.href.length };
    return { status: "ok", href: url.href };
  }

  // Links inside the primary region (or, in fallback mode, outside chrome).
  function collectLinks() {
    const root = primary ? primary.el : body;
    const els = root.querySelectorAll("a[href]");
    const items = [];
    const seen = new Set();
    let capped = false;
    const scan = Math.min(els.length, SCAN_CAP);
    for (let i = 0; i < scan; i++) {
      const el = els[i];
      if (!(el instanceof HTMLAnchorElement) || !isUsable(el)) continue;
      // Chrome links, and links in navigation inside the region, go to the navigation list.
      if (primary ? inInnerSkip(el) : nearestChrome(el)) continue;
      const label = labelOf(el) || "(no label)";
      // Same label + same raw destination = same evidence (repeated links).
      const key = label + "\u0000" + el.href;
      if (seen.has(key)) continue;
      seen.add(key);
      if (items.length >= limits.maxLinks) {
        capped = true;
        break;
      }
      items.push(Object.assign({ label }, classifyDestination(el)));
    }
    if (!capped && els.length > scan) capped = true;
    return { items, capped };
  }

  // Links in navigation / banner / footer / sidebar regions outside the
  // primary region: kept, but separate from the content.
  // Each region gets its own share of the cap, so one huge sidebar cannot
  // crowd out the header and footer links.
  function collectNavLinks() {
    const regions = navRegions;
    const quota = Math.max(8, Math.floor(limits.maxNavLinks / Math.max(1, regions.length)));
    const scanQuota = Math.max(50, Math.floor(limits.navScanCap / Math.max(1, regions.length)));
    const items = [];
    const seen = new Set();
    const seenEls = new Set();
    let capped = false;
    for (const region of regions) {
      let scanned = 0;
      let taken = 0;
      for (const el of region.querySelectorAll("a[href]")) {
        if (seenEls.has(el)) continue;
        seenEls.add(el);
        if (++scanned > scanQuota) {
          capped = true;
          break;
        }
        if (!(el instanceof HTMLAnchorElement) || !isUsable(el)) continue;
        const label = labelOf(el) || "(no label)";
        const key = label + "\u0000" + el.href;
        if (seen.has(key)) continue;
        seen.add(key);
        if (taken >= quota || items.length >= limits.maxNavLinks) {
          capped = true;
          break;
        }
        taken++;
        items.push(Object.assign({ label, region: nearestChrome(el) || chromeInfo.get(region) }, classifyDestination(el)));
      }
    }
    return { items, capped };
  }

  // ---- Other controls (buttons and form fields; links are separate) ---------------
  function collectControls() {
    const selector =
      'button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"]:not(a[href])';
    const root = primary ? primary.el : body;
    const els = root.querySelectorAll(selector);
    const items = [];
    const seen = new Set();
    let capped = false;
    const scan = Math.min(els.length, SCAN_CAP);
    for (let i = 0; i < scan; i++) {
      const el = els[i];
      if (!isUsable(el)) continue;
      if (primary ? inInnerSkip(el) : nearestChrome(el)) continue;
      const kind = kindOf(el);
      const label = labelOf(el) || "(no label)";
      const key = kind + "|" + label;
      if (seen.has(key)) continue;
      seen.add(key);
      if (items.length >= limits.maxControls) {
        capped = true;
        break;
      }
      items.push({ kind, label });
    }
    if (!capped && els.length > scan) capped = true;
    return { items, capped };
  }

  const headings = body ? collectHeadings() : { items: [], capped: false, outsideScope: 0 };
  const links = body ? collectLinks() : { items: [], capped: false };
  const navLinks = body ? collectNavLinks() : { items: [], capped: false };
  const controls = body ? collectControls() : { items: [], capped: false };

  return {
    // The document title is separate evidence; it is never used as a heading.
    title: clip((document.title || "").replace(/\s+/g, " ").trim(), limits.titleMax),
    // protocol + host + path only: no query string, no fragment, no credentials.
    url: clip(location.protocol + "//" + location.host + location.pathname, limits.urlMax),
    readyState: document.readyState,
    // How the page text was chosen. Fixed codes and numbers only.
    selection: {
      mode: primary ? "primary" : "fallback",
      regionType: primary ? primary.regionType : "none",
      reason,
      refined,
      candidatesFound,
      candidates: candidates.length,
      rejected,
      otherRegions,
      textChars: primary ? primary.len : 0,
      textCharsCapped: primary ? primary.capped : false,
      linkDensityPct: primary ? Math.round(primary.density * 100) : 0,
      coveragePct: coverage < 0 ? -1 : Math.round(coverage * 100),
      otherOutside: primary ? otherChars > limits.minRegionChars : false,
      fallbackIncludesChrome,
      excluded,
    },
    headings: headings.items,
    headingsCapped: headings.capped,
    headingsOutsideScope: headings.outsideScope,
    text: textResult.text,
    textTruncated: textResult.truncated,
    links: links.items,
    linksCapped: links.capped,
    navLinks: navLinks.items,
    navLinksCapped: navLinks.capped,
    controls: controls.items,
    controlsCapped: controls.capped,
    iframeCount: document.querySelectorAll("iframe, frame").length,
  };
}

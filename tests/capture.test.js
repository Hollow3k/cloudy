// Assertions on the captures of tests/.out/*.html made by dump-captures.js
// (real headless Chrome, real capture.js, rendered DOM).
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, ".out");
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 220) : ""}`);
const count = (s, sub) => s.split(sub).length - 1;
const labels = (arr) => arr.map((x) => x.label);

const S = {};
for (const n of fs.readFileSync(path.join(out, "names.txt"), "utf8").split(/\r?\n/).filter(Boolean)) {
  const raw = fs.readFileSync(path.join(out, `snap_${n}.json`), "utf8");
  if (raw === "NOJSON") { results.push("FAIL  fixture produced no capture: " + n); continue; }
  S[n] = { raw, s: JSON.parse(raw) };
}
const sel = (n) => S[n].s.selection;

try {
  // ===== 1. THE ROOT CAUSE: a display:contents <main> was treated as hidden =====
  let { s, raw } = S.ref_contents_main;
  ok("1: display:contents <main> IS found, used, and reported as the selected region", sel("ref_contents_main").mode === "primary" && sel("ref_contents_main").regionType === "main" && sel("ref_contents_main").reason === "main-region" && sel("ref_contents_main").candidatesFound === 1 && sel("ref_contents_main").candidates === 1, JSON.stringify(sel("ref_contents_main")));
  ok("1: nothing was rejected", Object.values(sel("ref_contents_main").rejected).every((v) => v === 0));
  ok("1: page text starts with the article's own title, then its prose", s.text.startsWith("<h1>–<h6> HTML section heading elements\n") && s.text.includes("The <h1> to <h6> HTML elements represent six levels of section headings."), s.text.slice(0, 120));
  const boxed = S.ref_boxed_main.s;
  ok("1: boxed <main> (control) and display:contents <main> give the same page text", boxed.text === s.text && sel("ref_boxed_main").regionType === "main");
  ok("1: same headings either way", JSON.stringify(boxed.headings) === JSON.stringify(s.headings));

  // ===== 2. Inline markup is preserved, with no stray spaces or duplicates =====
  ok("2: inline <code> inside a sentence keeps spacing and punctuation", s.text.includes("<h1> is the highest section level and <h6> is the lowest."));
  ok("2: adjacent inline elements with no whitespace stay joined (h1–h6)", s.text.includes("Range: h1–h6, and Note: levels must not be skipped."), s.text.slice(s.text.indexOf("Range"), s.text.indexOf("Range") + 60));
  ok("2: link inside parentheses keeps '(see the spec).'", s.text.includes("Prefer the guide (see the spec).") );
  ok("2: <strong> inline keeps its space ('Note: nesting')", s.text.includes("Note: nesting them was allowed"));
  ok("2: heading wording with inline code is exact", s.headings[0].text === "<h1>–<h6> HTML section heading elements" && s.headings.some((h) => h.text === "Avoid using multiple <h1> elements on one page" && h.level === 3));
  const lines = s.text.split("\n").filter((l) => l.length > 25);
  ok("2: no duplicated lines in the page text", lines.length === new Set(lines).size);
  ok("2: paragraph = one line (inline markup does not break lines)", !/\nand\n|\n<h6>\n/.test(s.text));

  // ===== 3. Navigation inside the region is navigation, not prose =====
  ok("3: 'In this article' table of contents is not in the page text or headings", !s.text.includes("In this article") && !s.headings.some((h) => h.text === "In this article") && s.headingsOutsideScope >= 1);
  ok("3: its links went to the navigation list", labels(s.navLinks).filter((l) => ["Try it", "Attributes", "Usage notes"].includes(l)).length === 3);
  ok("3: in-article links stay content links with exact destinations", s.links.some((l) => l.label === "the guide" && l.href === "https://site.test/guides/headings?lang=en&view=full") && s.links.some((l) => l.label === "font-size"));
  ok("3: menus/footer never reach the page text", !/Element-\d|Reference|REF_PAGE_FOOTER_MARKER|Privacy|Elements menu/.test(s.text));
  ok("3: separate navigation list is capped and flagged, every region represented", s.navLinks.length <= 60 && s.navLinksCapped === true && new Set(s.navLinks.map((l) => l.region)).size >= 3, [...new Set(s.navLinks.map((l) => l.region))].join(","));
  ok("3: all 18 article headings (h1 + 17 sections), levels 1-4, scoped to main", s.headings.length === 18 && s.headings.every((h) => h.where === "main"), String(s.headings.length));

  // ===== 4. Candidate rejection is reported, never called "absent" =====
  let q = sel("rej_hidden_main");
  ok("4: hidden <main>: found 1, rejected as not rendered, reason candidates-rejected (NOT no-semantic-region)", q.candidatesFound === 1 && q.candidates === 0 && q.rejected.notRendered === 1 && q.reason === "candidates-rejected" && q.mode === "fallback", JSON.stringify(q));
  ok("4: ...and the fallback text is the visible content, not the hidden text", S.rej_hidden_main.s.text.includes("VISIBLE_APP_TEXT") && !S.rej_hidden_main.s.text.includes("HIDDEN_MAIN_TEXT"));
  q = sel("rej_inside_chrome");
  ok("4: <article> inside <nav>: found, rejected as inside chrome", q.candidatesFound === 1 && q.rejected.insideChrome === 1 && q.reason === "candidates-rejected", JSON.stringify(q.rejected));
  q = sel("rej_little_text");
  ok("4: tiny <main>: usable but rejected for too little text", q.candidatesFound === 1 && q.candidates === 1 && q.rejected.littleText === 1 && q.reason === "too-little-text" && S.rej_little_text.s.text.includes("APP_BIG_TEXT"), JSON.stringify(q));
  q = sel("rej_editable");
  ok("4: contenteditable <article>: rejected as editable, text never read", q.candidatesFound === 1 && q.rejected.skipped === 1 && !S.rej_editable.raw.includes("EDITABLE_ARTICLE_TEXT"), JSON.stringify(q.rejected));
  q = sel("rej_none");
  ok("4: genuinely no main/article: reason no-semantic-region, nothing rejected", q.candidatesFound === 0 && q.reason === "no-semantic-region" && Object.values(q.rejected).every((v) => v === 0));
  ok("4: selection holds only fixed codes/numbers (no page text)", Object.keys(S).every((n) => /^[a-z=-]+$/.test(sel(n).regionType) && /^[a-z-]*$/.test(sel(n).reason) && !/MARKER|TEXT/.test(JSON.stringify(sel(n)))));

  // ===== 5. Non-article pages keep a nonempty fallback =====
  s = S.fallback_plain.s;
  ok("5: plain page: explicit fallback with content, chrome left out first", sel("fallback_plain").mode === "fallback" && sel("fallback_plain").reason === "no-semantic-region" && s.text.includes("PLAIN_BODY_MARKER_1") && !/NavA|PLAIN_FOOT_MARKER/.test(s.text) && labels(s.navLinks).join(",") === "NavA,NavB");
  s = S.chrome_only.s;
  ok("5: menu/footer-only page is not empty, flagged as including chrome", s.text.includes("Section-3") && s.text.includes("HUB_FOOT_MARKER") && sel("chrome_only").fallbackIncludesChrome === true);
  s = S.directory.s;
  ok("5: link directory keeps text + all 60 links (density disclosed)", sel("directory").mode === "primary" && s.text.includes("Tool 7 name") && s.links.length === 60 && sel("directory").linkDensityPct >= 80 && s.links[0].href === "https://site.test/tool/1?ref=dir&sort=name");
  s = S.product.s;
  ok("5: product page keeps price/stock/controls; select options unread", /Gadget 3000/.test(s.text) && /\$49\.99/.test(s.text) && /In stock/.test(s.text) && s.controls.some((c) => c.label === "Add to basket") && s.controls.some((c) => c.kind === "dropdown" && c.label === "Colour") && !S.product.raw.includes("RED_OPTION"));
  s = S.dashboard.s;
  ok("5: dashboard metrics/table/controls survive", ["Revenue", "$12,340", "Active users", "1,204", "Job A", "Running", "Job B", "Failed"].every((t) => s.text.includes(t)) && s.controls.some((c) => c.label === "Refresh") && s.controls.some((c) => c.label === "Filter jobs"));

  // ===== 6. Chrome must not consume the budget ahead of content =====
  s = S.chrome_pressure.s;
  ok("6: tiny content + huge nav/footer: content FIRST, chrome only appended after", s.text.startsWith("Tiny App\nAPP_CORE_TEXT only a few words here.") && sel("chrome_pressure").fallbackIncludesChrome === true && s.text.indexOf("Menu-1") > s.text.indexOf("APP_CORE_TEXT"), s.text.slice(0, 90));
  ok("6: ...within the text budget, and truncation flagged", s.text.length <= 2400 && s.textTruncated === true, String(s.text.length));
  s = S.primary_pressure.s;
  ok("6: article + huge chrome: primary selected, chrome absent from text, article whole", sel("primary_pressure").mode === "primary" && s.text.startsWith("Core Article") && s.text.includes("CORE_PARA_2") && !/Menu-|Footer legal/.test(s.text) && s.textTruncated === false);

  // ===== 7. Nested / multiple candidates and header handling =====
  s = S.nested_dominant.s;
  ok("7: nested dominant article: inner chosen, text once, widget excluded", sel("nested_dominant").regionType === "article" && sel("nested_dominant").reason === "inner-of-main" && count(s.text, "NESTED_UNIQUE_SENTENCE") === 1 && !s.text.includes("SIDE_WIDGET_MARKER"));
  s = S.cards.s;
  ok("7: three comparable cards: enclosing <main>, each card once", sel("cards").regionType === "main" && [1, 2, 3].every((i) => count(s.text, "CARD_MARKER_" + i) === 1));
  s = S.two_articles.s;
  ok("7: two comparable articles, no <main>: truthful ambiguous fallback, both kept once", sel("two_articles").mode === "fallback" && sel("two_articles").reason === "ambiguous-articles" && sel("two_articles").candidatesFound === 2 && count(s.text, "TWO_MARKER_A") === 1 && count(s.text, "TWO_MARKER_B") === 1);
  s = S.article_header.s;
  ok("7: article header title + intro kept; page banner/footer not", sel("article_header").reason === "dominant-article" && s.text.includes("Article Title Here") && s.text.includes("INTRO2_MARKER") && s.text.includes("ARTICLE2_FOOTER_MARKER") && !/SITE_BANNER_NAME|PAGE2_FOOTER|HomeNav/.test(s.text));

  // ===== 8. Privacy (inside a display:contents <main>, and in chrome) =====
  ({ s, raw } = S.privacy);
  ok("8: privacy fixture's display:contents <main> is selected", sel("privacy").mode === "primary" && s.text.includes("PRIV_BODY_MARKER"));
  const leaks = ["HIDDEN_DISPLAY_TEXT", "HIDDEN_VIS_TEXT", "HIDDEN_ATTR_TEXT", "SCRIPT_SECRET", "NOSCRIPT_TEXT", "PASSWORD_SECRET", "TYPED_SECRET", "TEXTAREA_SECRET", "OPTION_TEXT", "EDITABLE_SECRET", "IFRAME_SECRET", "SVG_TEXT", "SECRETTOKEN123", "NAVSECRET123", "FOOTSECRET", "FOOTER_PRIV_TEXT"];
  ok("8: no hidden/form/editable/iframe/svg/secret text in the capture", leaks.every((x) => !raw.includes(x)), leaks.filter((x) => raw.includes(x)).join(","));
  ok("8: tokened links (content, nav, footer) redacted with no destination", s.links.find((l) => l.label === "Login callback").status === "redacted" && s.navLinks.filter((l) => l.status === "redacted").length === 2 && s.navLinks.every((l) => l.status !== "ok" || !/token/i.test(l.href)));
  ok("8: functional query link kept whole", s.links.find((l) => l.label === "Functional query link").href === "https://site.test/search?q=hello+world&page=2");
  ok("8: password/text/textarea controls listed by label only", s.controls.some((c) => c.kind === "password field" && c.label === "Password") && s.controls.some((c) => c.kind === "text area" && c.label === "Notes"));
} catch (e) {
  results.push("CRASH " + e.stack);
}

const fails = results.filter((r) => /^(FAIL|CRASH)/.test(r)).length;
fs.writeFileSync(path.join(out, "capture_result.txt"), results.join("\n") + `\n\nFAILS: ${fails} of ${results.length}`);
console.log(results.join("\n") + `\n\ncapture tests: ${results.length - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

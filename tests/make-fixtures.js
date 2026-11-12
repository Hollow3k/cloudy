// Writes the HTML fixtures used by the capture tests into tests/.out/.
// Every page is plain HTML (no test code inside), so capture.js sees it the way
// it sees a real site. A <base> makes relative links resolve to https://.
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, ".out");
fs.mkdirSync(out, { recursive: true });

const page = (title, body, head = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><base href="https://site.test/dir/"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const para = (marker, n = 220) =>
  `<p>${marker} ` + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(Math.ceil(n / 76)).slice(0, n) + "</p>";
const navLinks = (prefix, n, base = "/docs") =>
  Array.from({ length: n }, (_, i) => `<li><a href="${base}/${prefix.toLowerCase()}-${i + 1}?x=1">${prefix}-${i + 1}</a></li>`).join("");

const files = {};

// A reference-style page: <main> is display:contents (it has no box of its own),
// the article text uses inline markup, a table of contents <aside><nav> sits
// INSIDE main, and heavy site navigation surrounds it.
const refSections = [
  ["Try it", 2, "Interactive examples live here, so this section has only a short line of text."],
  ["Attributes", 2, "These elements only include the global attributes. The <code>headingoffset</code> and <code>headingreset</code> global attributes can adjust the computed level."],
  ["Usage notes", 2, "Heading information can be used by user agents to build a table of contents. Do not use heading elements to resize text; use the CSS <a href=\"/css/font-size?v=1\"><code>font-size</code></a> property instead."],
  ["Avoid using multiple <h1> elements on one page", 3, "While using multiple <code>&lt;h1&gt;</code> elements is allowed, it is not a best practice. <strong>Note:</strong> nesting them was allowed in older versions of the standard (see <a href=\"/spec/outline\">the outline note</a>)."],
  ["Specifying a uniform font size for <h1>", 3, "Use <code>:where()</code> selectors to reset the size."],
  ["Accessibility", 2, "A common navigation technique for screen reader users is to jump from heading to heading."],
  ["Navigation", 3, "Do not skip heading levels."],
  ["Nesting", 4, "Nested sectioning content can reset the level."],
  ["Labeling section content", 3, "Use <code>aria-labelledby</code> to label a <code>&lt;section&gt;</code>."],
  ["Sectioning content examples", 4, "Examples follow."],
  ["Examples", 2, "All six levels are shown below."],
  ["All headings", 3, "The markup below uses every level."],
  ["Example page", 3, "A complete page outline."],
  ["Technical summary", 2, "Content categories: flow content, heading content."],
  ["Specifications", 2, "See the HTML standard."],
  ["Browser compatibility", 2, "Supported in every browser."],
  ["See also", 2, "Related reading."],
];
const refBody = refSections
  .map(([h, lvl, text], i) => `<h${lvl}>${h.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</h${lvl}><p>${text}</p>${para("REF_FILLER_" + i, 300)}`)
  .join("");
files.ref_contents_main = page("<h1>–<h6> HTML section heading elements - HTML | MDN-like",
  `<ul class="skip"><li><a href="#content">Skip to main content</a></li></ul>
   <header><a href="/"><img alt="Site logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
     <nav aria-label="Primary"><ul>${["Reference", "Guides", "Learn", "Blog", "Community", "Support"].map((t) => `<li><a href="/${t.toLowerCase()}">${t}</a></li>`).join("")}</ul></nav>
     <form><input type="search" placeholder="Search site"></form></header>
   <div class="layout" style="display:grid;grid-template-columns:200px 1fr">
     <aside id="side"><nav><h2>Elements menu</h2><ul>${navLinks("Element", 150)}</ul></nav></aside>
     <main id="content" style="display:contents">
       <div class="head"><h1><code>&lt;h1&gt;</code>–<code>&lt;h6&gt;</code> HTML section heading elements</h1></div>
       <aside class="toc"><h2>In this article</h2><nav><ul><li><a href="#try">Try it</a></li><li><a href="#attr">Attributes</a></li><li><a href="#usage">Usage notes</a></li></ul></nav></aside>
       <div class="prose">
         <p>The <code>&lt;h1&gt;</code> to <code>&lt;h6&gt;</code> HTML elements represent six levels of section headings. <code>&lt;h1&gt;</code> is the highest section level and <code>&lt;h6&gt;</code> is the lowest.</p>
         <p>Prefer <a href="/guides/headings?lang=en&amp;view=full">the guide</a> (see <a href="/spec/x">the spec</a>).</p>
         <p>Range: <code>h1</code>–<code>h6</code>, and <strong>Note:</strong> levels must not be skipped.</p>
         ${refBody}
       </div>
     </main>
   </div>
   <footer>REF_PAGE_FOOTER_MARKER <a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer>`);

// Same content with an ordinary (boxed) <main>: the control case.
files.ref_boxed_main = files.ref_contents_main.replace('id="content" style="display:contents"', 'id="content"');

// ---- Candidate rejection reporting ------------------------------------------------
const big = (m) => para(m, 700);
files.rej_hidden_main = page("Hidden main",
  `<main style="display:none">${big("HIDDEN_MAIN_TEXT")}</main><div class="app">${big("VISIBLE_APP_TEXT")}</div>`);
files.rej_inside_chrome = page("Article in nav",
  `<nav><article>${big("CHROME_ARTICLE_TEXT")}</article></nav><div class="app">${big("APP_TEXT")}</div>`);
files.rej_little_text = page("Tiny main",
  `<main><p>Short.</p></main><div class="app">${big("APP_BIG_TEXT")}</div>`);
files.rej_editable = page("Editable article",
  `<article contenteditable="true">${big("EDITABLE_ARTICLE_TEXT")}</article><div class="app">${big("APP2_TEXT")}</div>`);
files.rej_none = page("No semantic elements",
  `<div class="wrap"><div class="c"><h1>Plain</h1>${big("PLAIN_TEXT")}</div></div>`);

// ---- Budget pressure from page chrome --------------------------------------------
// Little real content, a lot of navigation + footer text: the content must come
// first, with chrome only appended after it.
files.chrome_pressure = page("Small content, huge chrome",
  `<header><nav><ul>${navLinks("Menu", 200)}</ul></nav></header>
   <div class="app"><h1>Tiny App</h1><p>APP_CORE_TEXT only a few words here.</p></div>
   <footer>${"Footer legal text ".repeat(120)}</footer>`);
// Primary content with huge chrome: chrome must not appear in the text at all.
files.primary_pressure = page("Article with huge chrome",
  `<header><nav><ul>${navLinks("Menu", 300)}</ul></nav></header>
   <main><article><h1>Core Article</h1>${para("CORE_PARA_1", 400)}${para("CORE_PARA_2", 400)}</article></main>
   <footer>${"Footer legal text ".repeat(150)}</footer>`);

// ---- Non-article pages ------------------------------------------------------------
files.fallback_plain = page("Plain Page",
  `<div class="wrap"><div class="content"><h1>Plain Heading</h1>${para("PLAIN_BODY_MARKER_1", 260)}${para("PLAIN_BODY_MARKER_2", 260)}
   <p><a href="/plain/link?a=1&amp;b=2">Plain link</a></p><button>Plain button</button></div>
   <nav><a href="/na">NavA</a> <a href="/nb">NavB</a></nav><footer>PLAIN_FOOT_MARKER</footer></div>`);
files.chrome_only = page("Link Hub",
  `<nav><h2>Sections</h2><ul>${navLinks("Section", 12, "/s")}</ul></nav><footer>HUB_FOOT_MARKER <a href="/about">About</a></footer>`);
files.directory = page("Tool Directory",
  `<main><h1>Tool Directory</h1><ul>${Array.from({ length: 60 }, (_, i) => `<li><a href="/tool/${i + 1}?ref=dir&amp;sort=name">Tool ${i + 1} name</a></li>`).join("")}</ul></main>`);
files.product = page("Shop",
  `<div class="top"><nav><a href="/shop/home">Shop home</a><a href="/shop/cart">Cart</a></nav></div>
   <div class="product"><h1>Gadget 3000</h1><p>Price: $49.99</p><p>In stock</p><label for="c">Colour</label><select id="c"><option>RED_OPTION</option></select><button>Add to basket</button></div>`);
files.dashboard = page("Dashboard",
  `<div id="app"><div class="card"><h2>Revenue</h2><p>$12,340</p></div><div class="card"><h2>Active users</h2><p>1,204</p></div>
   <table><tr><th>Name</th><th>Status</th></tr><tr><td>Job A</td><td>Running</td></tr><tr><td>Job B</td><td>Failed</td></tr></table>
   <button>Refresh</button><input type="search" placeholder="Filter jobs"></div><nav><a href="/d/settings">Settings</a></nav>`);

// ---- Nested / multiple candidates -------------------------------------------------
files.nested_dominant = page("Nested A",
  `<main><div class="widget">SIDE_WIDGET_MARKER small</div><article><h1>Nested Title</h1>${para("NESTED_UNIQUE_SENTENCE", 600)}</article></main>`);
files.cards = page("Cards",
  `<main><h1>Card list</h1>${[1, 2, 3].map((i) => `<article><h2>Card ${i}</h2>${para("CARD_MARKER_" + i, 220)}</article>`).join("")}</main>`);
files.two_articles = page("Two Articles",
  `<article><h1>First article</h1>${para("TWO_MARKER_A", 400)}</article><article><h1>Second article</h1>${para("TWO_MARKER_B", 400)}</article>`);
files.article_header = page("Tab Title Different",
  `<header><span>SITE_BANNER_NAME</span><nav><a href="/h">HomeNav</a></nav></header>
   <article><header><h1>Article Title Here</h1><p>INTRO2_MARKER A short standfirst that introduces the piece and sets expectations for readers.</p></header>
   ${para("BODY2_MARKER_1")}<section><header><h2>Section Heading</h2></header>${para("BODY2_MARKER_2")}</section>
   <footer>ARTICLE2_FOOTER_MARKER</footer></article><footer>PAGE2_FOOTER</footer>`);

// ---- Privacy: traps inside a display:contents <main> and in chrome ----------------
files.privacy = page("Privacy Fixture",
  `<header><nav><a href="https://x.test/cb?access_token=NAVSECRET123&amp;x=1">Nav login</a></nav></header>
   <main style="display:contents"><article><h1>Visible Article</h1>${para("PRIV_BODY_MARKER", 300)}
   <div style="display:none">HIDDEN_DISPLAY_TEXT</div><span style="visibility:hidden">HIDDEN_VIS_TEXT</span><div hidden>HIDDEN_ATTR_TEXT</div>
   <script>var SCRIPT_SECRET=1;</script><style>.x{}</style><noscript>NOSCRIPT_TEXT</noscript>
   <label for="pw">Password</label><input id="pw" type="password" value="PASSWORD_SECRET">
   <input type="text" value="TYPED_SECRET" placeholder="Search things">
   <label>Notes <textarea>TEXTAREA_SECRET</textarea></label><select aria-label="Color"><option>OPTION_TEXT</option></select>
   <div contenteditable="true">EDITABLE_SECRET</div><iframe srcdoc="<p>IFRAME_SECRET</p>"></iframe><canvas></canvas><svg><text>SVG_TEXT</text></svg>
   <a href="https://shop.test/cb?access_token=SECRETTOKEN123&amp;x=1">Login callback</a>
   <a href="/search?q=hello+world&amp;page=2">Functional query link</a></article></main>
   <footer><a href="https://f.test/p#access_token=FOOTSECRET&amp;token_type=bearer">Footer token</a> FOOTER_PRIV_TEXT</footer>`);

for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(out, name + ".html"), html);
fs.writeFileSync(path.join(out, "names.txt"), Object.keys(files).join("\n"));
console.log(Object.keys(files).length + " fixtures written to " + out);

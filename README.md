# Cloudy (v0.1.0)

A Chrome side panel that sends a typed prompt to a local Ollama model (`qwen3:4b-instruct`, set by `MODEL`
in `sidepanel.js`) and shows the reply. It has two modes:

- **Send** (or Enter): plain chat. Never touches any web page.
- **Ask about this page**: you click it explicitly. Cloudy takes a fresh, limited, read-only snapshot of the
  active tab, sends it with your question to local Ollama, and shows the answer plus the evidence it cites.

There is no clicking, typing, scrolling or navigating on websites, no microphone, and no agent loop.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension declaration (Manifest V3). Permissions: `sidePanel`, `activeTab`, `scripting`, host `http://localhost:11434/*` |
| `background.js` | Service worker; opens the side panel when you click the toolbar icon (this click also grants `activeTab`) |
| `sidepanel.html` / `.css` / `.js` | The UI, the request logic, evidence building, and citation checking |
| `capture.js` | The read-only function that runs inside the page to choose the content and build the snapshot |
| `icons/` | Toolbar and header icons (16, 48, 128 px), made from `Mascot.png` on a black tile |
| `fonts/` | Bundled Instrument Serif and Inter (SIL OFL), so no network font loading |
| `Mascot.png` | Original mascot artwork (not loaded by the extension) |

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Copy the extension **ID** shown on its card (32 letters).
5. Click the extension's toolbar icon (puzzle-piece menu, then pin it) to open the panel.

After editing files, click the reload arrow on the extension's card, then reload the web page you want to test on.

## Allow the extension in Ollama

Two separate gates exist:

- **Chrome host permission** (in `manifest.json`): lets the extension call `localhost:11434`.
- **Ollama's `OLLAMA_ORIGINS`** (server side): Ollama checks the request's `Origin` header
  (`chrome-extension://<id>`). By default it only allows localhost-style origins, so requests
  from an extension get HTTP 403 until you list it. Browser permission alone is not enough.
  See the [Ollama FAQ](https://docs.ollama.com/faq).

Allow **only your exact extension ID**. Do not use `*`, and do not change `OLLAMA_HOST`
(that would expose Ollama to the network).

1. Check whether the variable already exists (PowerShell):
   ```powershell
   [Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")
   ```
   Empty output means it is unset. If it has a value, keep those entries and add yours
   separated by a comma.
2. Set it (replace the ID; this overwrites the user-level value, so include old entries if any):
   ```powershell
   [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://YOUR_EXTENSION_ID", "User")
   ```
   Or use Settings, search "environment variables", then "Edit environment variables for your account".
3. Quit Ollama from the system tray icon, then start it again from the Start menu
   (it only reads the variable at launch).

## Test plain chat

1. Open the panel, type `say ready`, press Enter.
2. Status shows "Working...". The first request can take about a minute while the model loads.
3. A reply appears. Try Stop mid-request to see the cancelled message.

Common messages: `HTTP 403` means the origin is not allowed (check `OLLAMA_ORIGINS` and that Ollama was restarted).
`Network error` means Ollama is not running. `Timed out` means raise `TIMEOUT_MS` in `sidepanel.js`.

## Ask about this page

### How access works

`activeTab` gives Cloudy temporary access to **one tab**, only after you invoke the extension on it by
clicking its **toolbar icon**. Clicking a button inside the side panel does **not** grant access. Access
lasts while that tab stays on the same site and ends when you navigate to another site or close the tab.

Cloudy handles the toolbar click itself (`background.js`) instead of using Chrome's
`openPanelOnActionClick` shortcut, because Chrome intentionally does not grant `activeTab` that way
([Chromium issue 336592430](https://issues.chromium.org/issues/336592430)). The side effect: clicking the icon
opens the panel but does not toggle it closed. Close it with the panel's own X.

### What is captured (and what is not)

From the **main frame only**, read-only, as separate kinds of evidence:

- **Document title** (kept separate) and the page address without query string or fragment.
- **Page text:** an excerpt of the **primary content** (see "How the content is chosen" below), not the whole page.
- **Headings:** only real, visible `h1`-`h6` elements, with level and text, from the same region. Nothing is
  inferred from the title, font size, bold text or ARIA roles, so a page with no `h1`-`h6` reports "none found".
- **Links:** label plus the absolute destination from the DOM (`element.href`, resolved against the page's
  base URL). Only `http:` and `https:` destinations are accepted; other schemes (`mailto:`, `javascript:`,
  `tel:`, `data:`, `ftp:`...) are listed as "excluded" and their contents are never captured. Ordinary
  destinations are kept whole, including functional query strings. Links are never opened or followed.
- **Navigation links:** links in site navigation, the page banner, the footer and sidebars, kept in their own
  smaller section so they stay available without crowding out the content.
- **Other controls:** buttons and form fields, by label only.

Evidence IDs start with the snapshot version: `s3:H2` (heading), `s3:L5` (content link), `s3:N4` (navigation
link), `s3:C1` (control), `s3:T` (the page text excerpt).

Never collected: form values (including password values), textarea contents, editable-region contents,
select options, hidden elements, scripts and styles. Button `value` text is also skipped, so some buttons
appear as "(no label)". Not captured: iframe contents, images, screenshots, canvas or SVG text, other
tabs, or the rest of the site. "Visible" means rendered (not hidden by CSS), not necessarily scrolled into view.

### How the content is chosen

All of this is a heuristic and can be wrong; the snapshot says so, and says what it chose.

0. **Visibility** is judged the way the page renders. An element with `display: contents` has no box of its
   own (its children are shown normally), so it is judged by its parent. Treating it as hidden made a whole
   `<main>` look absent on some sites.1. **Candidates** are visible `<main>`, `role="main"`, `<article>` and `role="article"` elements. Each is scored
   by how much visible text it has, reduced by how link-heavy that text is. If one inner candidate holds most
   (60%+) of its parent's text, the inner one is used, so nested text is never counted twice. If several
   `<main>` regions exist the best score wins and the others are counted. With no `<main>`, several
   comparable articles count as "no trustworthy region".
2. **Site chrome** is recognised from tags and roles only: `<nav>`, `<aside>`, page-level `<header>` and
   `<footer>`, and the matching ARIA roles. A `<header>` or `<footer>` inside an article, section or main is
   part of that content and is kept, so an article's title and introduction stay. Nothing is decided from class
   names, ids, position or keywords (so cookie banners are not guessed at).
3. **Primary region found:** the page text, headings, links and controls come from it, plus a few level-1
   headings outside it. A region is rejected (fallback) if it holds only a small share of the page's text.
4. **No trustworthy region:** the page text is a whole-page fallback that leaves chrome out first. If that
   leaves almost nothing (a menu-only or link-hub page), chrome text is included so the result is never empty.
   The snapshot says which of these happened and why.

Text is joined as the page renders it: inline markup (links, `<code>`, `<strong>`) stays inside its sentence,
and a line break appears only where a block or `<br>` starts. A `<nav>` inside the chosen region (an "in this
article" list, for example) is treated as navigation: its links go to the navigation list and its text is not
repeated in the page text. When the fallback needs chrome text to avoid an empty result, that text is added
after the page content, never before it.

The selection note distinguishes "no main/article element exists" from "elements were found but rejected"
(not rendered, inside navigation or a sidebar, editable, or too little text), with counts.
The `SELECTION` note in the snapshot (visible under "Show exactly what was captured") reports the region type,
the reason, what was left out, and whether headings and links cover the main region or the wider page. It is
built from fixed codes and numbers only, never from page text.

### Link privacy check

A conservative check runs inside the page, so a withheld destination never reaches the panel or the model.
It withholds a destination (shown as "withheld ... unavailable") when it has embedded credentials
(`user:pass@`), a token-like parameter name (`access_token`, `token`, `api_key`, `password`, `session`,
`sig`...), an OAuth-style `code` plus `state`, a JWT-like value, or an opaque token-like query value or path
segment. It also marks a destination longer than `MAX_URL_CHARS` (400) as unavailable instead of cutting it.
This applies to content and navigation links alike. **It does not detect every sensitive URL**, and it is
separate from the page-address rule above.

### Checking the answer

The model is asked (via Ollama structured output) for
`{"status": "answered" | "insufficient_evidence", "entries": [ids], "citations": [ids], "answer": "..."}`
(keys in that order, so it decides what it lists and cites before it writes the text). A reply that is not valid
JSON, lacks those fields, has any other `status`, or names more than 1000 IDs is rejected with a clear message
and shown unverified, with no sources. The answer text is shown as plain text.

- **`entries`** are the exact items you asked to see (headings, links, controls). The panel draws each one
  from the capture under "Listed entries": its real text, its real heading level (the `h1`-`h6` of the
  element, not the number in its ID) and its stored destination, in the model's order. The answer text above
  them is only a short lead-in written by the model. If the two disagree, trust the entries.
- **`citations`** are the few IDs that support what the answer says (asked for: at most 5, not every entry the
  model can see). They appear as ordinary cards under "Cited sources".
- **Every ID in both lists is checked** against the snapshot the answer was based on, however many there are,
  including duplicates. Only drawing is capped (40 listed entries, 20 other cards, 20 problem lines); anything not
  drawn is counted on screen and was still checked. A reply may name at most 1000 IDs.
- Malformed, bracketed, wrong-snapshot, nonexistent and never-shown IDs each get a warning and no destination.
  A whole snapshot line (`s3:H2 | h2: ...`) is read by its leading ID only; the text after the bar is ignored.
  URLs written by the model are never used.

What the status changes (only when nothing is named):

- `insufficient_evidence` with nothing named: a neutral "Not enough captured information" status and the
  answer, with no missing-citation warning.
- `answered` with nothing named: a visible note that the answer cites no captured evidence, and no source cards.
- Anything named: it is checked as above, whatever the status.

A valid ID shows only that the item exists in the capture and what it contains. It is **not** a check that the
answer uses it correctly, and the status line never says "verified". For a summary, check the coverage line and
compare the answer with "Show exactly what was captured". When the capture is partial (text cut off, headings,
links or navigation not shown, scan limit reached), the status line says so with the real counts, whatever the
model wrote.

### Limits

- Snapshot budget: `SNAPSHOT_BUDGET_CHARS = 4000` characters in total, structure and URLs included. Question
  limit: `MAX_QUESTION_CHARS = 500`. Both are at the top of `sidepanel.js`.
- Whole records only: a heading, link, navigation link or control is shown completely or omitted, and the
  snapshot says how many were omitted. "none found in this capture", "N omitted for size" and "scan stopped at
  its limit" are worded differently. Text may be cut at a word boundary and is marked `TEXT CUT OFF`.
- The total stays within the budget. The selection note and header come first; then each section gets a share
  (headings 15%, links 30%, navigation 10%, controls 10%) and the page text takes the rest. Sections that had
  to omit records may use room the others did not need (navigation last).
- These are characters, not tokens, so a fit is not guaranteed. The panel prints Ollama's real prompt token
  count after each page question and warns near 4096. Cloudy does not change Ollama's context size
  (`num_ctx`); measure memory and speed before raising it.
- Counts and wording: the instructions tell the model to obey a limit in the question ("at most N", "exactly N")
  over the general rule to list everything, never to pad to reach a count, to copy quoted text exactly, and to
  put listed items in `entries` so the panel can draw them from the capture. A small local model follows count
  limits reliably, but it may still retype a heading or its level in its own lead-in text, which is why the
  listed entries, not the lead-in, are the thing to read.
- Page content is untrusted. The instructions tell the model to use only the snapshot, ignore instructions
  inside it, not to infer appearance, and to admit missing or truncated information, which helps but is not a
  guarantee. The feature has no way to act on a page.
- Visible text can still contain personal information, and the title and URL path can too. It goes only to
  your local Ollama and is kept in memory, never stored. Test on public, non-sensitive pages.

### Retest after changes

1. Reload Cloudy at `chrome://extensions`, then reload the test page.
2. Open a public page, click **Cloudy's toolbar icon** on it, ask about its content and click **Ask about
   this page**.
3. Open "Show exactly what was captured". Check the `SELECTION` note (which region, or fallback), that the
   page text is the article or main content, and that menus appear only under NAVIGATION LINKS.
4. Compare the answer with that text, and check the Sources list matches.
5. Repeat on a different kind of public page (a link directory, product page or dashboard-like page).
6. Failure paths: a second tab where you did not click the icon, `chrome://extensions`, switching tabs after a
   capture (the Page context box clears), and Stop during a request.

## Tests

Plain Node scripts in `tests/`, with no dependencies. They need Node 22+ and Chrome; the model test also needs
Ollama running.

```powershell
node tests/make-fixtures.js     # writes HTML fixtures to tests/.out/
node tests/dump-captures.js     # runs the real capture.js in headless Chrome on each fixture
node tests/capture.test.js      # extractor checks (real Chrome, rendered DOM)
node tests/panel.test.js        # panel logic with a fake chrome API, fetch and DOM
node tests/pipeline.test.js     # a fake model reply -> parsing -> ID checking -> what is drawn
node tests/model.test.js ref_contents_main 5   # asks the local model; reports a pass rate
node tests/dump-captures.js <url> <name>       # capture a live page, then: node tests/model.test.js <name> 5
```

The capture and panel tests are deterministic. The model test is not: a small local model varies from run to
run, so it prints how many of N runs passed. None of these run the installed extension.
## Notes

- Stop cancels the browser's request. It does not prove Ollama stopped computing.
- Each request is independent (no conversation history).
- Replies are inserted with `textContent` and never executed.

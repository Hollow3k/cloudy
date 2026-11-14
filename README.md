# Cloudy (v0.1.0)

A Chrome side panel that sends a typed prompt to a local Ollama model (`qwen3:4b-instruct`, set by `MODEL`
in `sidepanel.js`) and shows the reply. It has two modes:

- **Send** (or Enter): plain chat. Never touches any web page.
- **Ask about this page**: you click it explicitly. Cloudy takes a fresh, limited, read-only snapshot of the
  active tab, sends it with your question to local Ollama, and shows the answer plus the evidence it cites.

- **Suggest next action**: you type a goal and click it. Cloudy lists the page's controls and asks the local model for
  ONE next step (click, type, scroll, ask you, or "cannot"). It **proposes**; nothing happens until you press
  **Approve** on that one proposal. Approve runs exactly that one action (see "Approving one action").

Cloudy never acts on its own: no automatic chain of steps (after an approved action it captures the page again and
stops), no microphone, no vision.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension declaration (Manifest V3). Permissions: `sidePanel`, `activeTab`, `scripting`; hosts `http://localhost:11434/*`, `https://*/*`, `http://*/*` |
| `background.js` | Service worker; opens the side panel when you click the toolbar icon (this click also grants `activeTab`, the fallback when Chrome withholds site access) |
| `sidepanel.html` / `.css` / `.js` | The UI, the request logic, evidence building, and citation checking |
| `capture.js` | The read-only function that runs inside the page to choose the content and build the snapshot |
| `targets.js` | The read-only function that runs inside the page to list its links, buttons and supported form controls (for Suggest next action) |
| `actions.js` | Pure logic for Suggest next action: control IDs, the bounded list, the prompt, the strict reply validation, scroll limits and approval eligibility (no DOM, no `chrome.*`) |
| `executor.js` | The only code that clicks, types or scrolls. Runs inside the page, once per approved action, and re-checks the control first |
| `icons/` | Toolbar and header icons (16, 48, 128 px), made from `Mascot.png` on a black tile |
| `fonts/` | Bundled Instrument Serif and Inter (SIL OFL), so no network font loading |
| `Mascot.png` | Original mascot artwork (not loaded by the extension) |

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Copy the extension **ID** shown on its card (32 letters).
5. Click the extension's toolbar icon (puzzle-piece menu, then pin it) to open the panel. (Reading normal pages
   needs no further click; see "How access works" below.)

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

Cloudy declares host access to ordinary websites (`https://*/*` and `http://*/*`; not `file://`, and not
`<all_urls>`). With that, it can read the active tab of a normal http/https page **without a toolbar click**.
Chrome shows this as "Read and change all your data on all websites" when you install or reload the extension.
Cloudy only reads a page when you click **Ask about this page** or **Suggest next action**; nothing is read
when you switch tabs.

Chrome still decides what Cloudy may read:

- **Site access.** At `chrome://extensions` > Cloudy > Details you can set "Site access" to "On click" or "On
  specific sites". Then Chrome withholds access on other pages, and Cloudy says so. Either set it to "On all
  sites", or click **Cloudy's toolbar icon** on that tab: `activeTab` then gives temporary access to that one
  tab (until it navigates to another site or closes). Clicking a button inside the side panel does **not** grant
  access.
- **Restricted pages.** Chrome never lets extensions read `chrome://` pages, other extensions' pages, the
  Chrome Web Store, `file://` pages (Cloudy does not ask for them) and similar. Cloudy
  shows "Page access: unavailable" for these and does nothing.
- **Access indicator.** The line at the top of "Page context" shows whether the active tab can be read. It looks
  only at the tab's address and the access Chrome has granted. It injects nothing and captures nothing. When the
  tab becomes unreadable, an earlier capture or proposal is cleared so it cannot look current.

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
2. Open a public http/https page with the panel open (no toolbar click on that page), ask about its content and
   click **Ask about this page**. The line above the page info should say the page can be read.
3. Open "Show exactly what was captured". Check the `SELECTION` note (which region, or fallback), that the
   page text is the article or main content, and that menus appear only under NAVIGATION LINKS.
4. Compare the answer with that text, and check the Sources list matches.
5. Repeat on a different kind of public page (a link directory, product page or dashboard-like page).
6. Failure paths: `chrome://extensions` and the Chrome Web Store (both should show "Page access: unavailable"
   and an earlier capture should clear), switching tabs after a capture (the Page context box clears), setting
   Cloudy's Site access to "On click" (other pages should show the withheld message until you click the icon or
   allow all sites), and Stop during a request.

## Tests

Plain Node scripts in `tests/`, with no dependencies. They need Node 22+ and Chrome; the model test also needs
Ollama running.

```powershell
node tests/make-fixtures.js     # writes HTML fixtures to tests/.out/
node tests/dump-captures.js     # runs the real capture.js in headless Chrome on each fixture
node tests/capture.test.js      # extractor checks (real Chrome, rendered DOM)
node tests/panel.test.js        # panel logic with a fake chrome API, fetch and DOM
node tests/pipeline.test.js     # a fake model reply -> parsing -> ID checking -> what is drawn
node tests/make-action-fixtures.js && node tests/dump-targets.js   # fixtures -> real targets.js in headless Chrome
node tests/targets.test.js      # what the page-side capture returned (privacy, names, bounds, DOM changes)
node tests/proposal.test.js     # fake model reply -> validation -> live recheck -> what is displayed
node tests/positions.test.js     # control rectangles/centres, what is serialized to the model (no model call)
node tests/exec.test.js          # approval + dispatch against a real headless-Chrome DOM (scripted model reply)
node tests/exec-mutants.js       # breaks one safeguard at a time and checks exec.test.js notices
node tests/action-model.test.js 5   # the local model's DECISIONS (rate per scenario)
node tests/position-model.test.js 4 # the local model on positional goals ("bottom left", "the button")
node tests/measure-prompt.js act_addremove "click the bottom left button" 3   # real prompt tokens for one fixture + goal
node tests/render-panel.js      # the real panel in headless Chrome at side-panel width (screenshots)
node tests/model.test.js ref_contents_main 5   # asks the local model; reports a pass rate
node tests/dump-captures.js <url> <name>       # capture a live page, then: node tests/model.test.js <name> 5
```

The capture and panel tests are deterministic. The model test is not: a small local model varies from run to
run, so it prints how many of N runs passed. None of these run the installed extension.
## Suggest next action

You type a goal ("search for red running shoes"), then click **Suggest next action**. Cloudy shows the proposed
step in words so you can judge it. It performs nothing unless you approve that one proposal (below).

### What is captured

`targets.js` scans the **whole main frame** (not just the article region, because search boxes and menus usually sit
outside it) and lists visible links, buttons, checkboxes, radio buttons, disclosures and text fields/areas, each
with an ID scoped to that capture (`a3:E7`), its kind, name, region (search, navigation, main, banner, footer...),
disabled/read-only state, and whether it is in view or offscreen. It is a supported subset of accessible-name
rules (aria-labelledby, aria-label, `<label>`, visible button/link text, image alt, svg title, title attribute,
and the placeholder as a **flagged weak fallback**), not a full accessibility tree.

- **Never read:** any input, textarea or select value, password value, autofill content or contenteditable text. No
  field is ever checked for emptiness. A submit button's `value` is not used as its name either, so
  `<input type="submit" value="Search">` appears unnamed.
- **Left out:** hidden controls (only counted).
- **Listed but unsupported for proposals:** password and file fields, select menus, other input types,
  contenteditable regions, and fields that look like credential or payment fields.
- **Not covered, and reported:** iframes, shadow roots and canvas are counted, not entered.
- **Bounded:** at most 150 controls are captured and about 3200 characters are sent to the model; the rest is
  stated as omitted. The 4000-character Q&A budget is separate and unchanged.

### Control positions

Each control's box comes from `getBoundingClientRect()` (x, y, width, height in CSS pixels from the viewport's
top-left, rounded to 0.1 px). The **full box stays in the panel's memory**. The model only gets the rounded **centre**
beside the control's existing position/state, for example:

```
a1:E2 | button | name: "Delete" | region: main | in view [35,111] | same name as 3 other control(s), this is 1 of 4
```

The format is defined once, in the prompt's `Viewport:` line: viewport W x H in CSS pixels, `[x,y]` = the control's
centre from the viewport's top-left, x rightwards, y downwards. Offscreen controls keep their real centre (outside
0..W or 0..H) and stay marked OFFSCREEN. A control with no box of its own is listed as "position unknown" with no
coordinates. For goals with position words ("bottom left", "first", "next to") the model is told to decide from the
relative layout of the controls that fit the rest of the goal and to answer with the control **ID**, never with
coordinates. If the goal does not single out one control it should ask, and a positional request that cannot be
resolved is not a reason to scroll.

Positions are read again with every fresh capture (each click on Suggest next action). Nothing re-captures on
scroll, resize or tab events, and a scroll does not make a proposal "stale". Nothing acts on coordinates.

### What the panel checks (format, not wisdom)

The reply must have exactly seven fields and an allowed action (`click`, `type`, `scroll`, `ask_user`,
`cannot`). Fields the action does not use are ignored and flagged. Then, for click/type: the ID must belong to
**this** capture and have been **shown to the model**; the control must exist, be enabled and (for typing) not
read-only; the action must fit the control (no typing into buttons, no clicking text fields); typed text may only
use words from **your goal** and may not look like a card number or token; credential-looking fields are refused;
and labels such as buy, pay, delete or send are refused as consequential. A keyword list cannot prove that anything
else is harmless, so a passing proposal is only called **"valid target/action format"**.

### Freshness

An unchanged address is not proof of an unchanged page. Right before showing a proposal, Cloudy reads the page
again and compares: same document (a reload gives a new one even at the same address), same tab and address, the
proposed control still present with the same name, state and place in the page, and the list of controls
unchanged. Scrolling does not count as a change. If any of that fails, or the page cannot be read again, the
proposal is shown as **stale / freshness not established** and you are asked to capture again. Switching tabs,
navigating, reloading or closing the tab clears a displayed proposal. A DOM change that happens *after* a proposal
is displayed is not noticed until the next capture, which is why Approve checks the page again right before acting.

### Approving one action

Approve is offered only for a proposal that is valid, fresh, and a click, type or scroll that is actually possible.
Nothing is offered for `ask_user` or `cannot`, for a blocked or invalid proposal, for a control that is offscreen
(scroll first; a scroll needs its own approval), or for a scroll that has nowhere to go.

- **Blocked vs invalid.** A reply that does not fit the format (made-up or stale ID, click on a text field) is shown as
  *invalid format*. A well-formed reply that Cloudy's rules refuse (disabled, read-only, password/credential or payment
  field, unsupported control, consequential names such as **Delete**, secret-shaped text, words not in your goal) is
  shown as *blocked by a rule*. The consequential-name block is unchanged: Delete stays blocked.
- **One approval, one action.** The approval is bound to the exact action, control, text or direction, tab and
  document. It is consumed before anything runs, so repeated clicks cannot run it twice. A new proposal, a tab switch,
  a navigation, closing the tab or a stale page ends it.
- **Checked again right before acting.** Cloudy reads the page again and requires: same tab, address and document;
  the same *element* (found by an identity key that survives re-capture, not by its `E` number, and never a look-alike);
  unchanged name, kind and state; the same list of controls; the safety rules applied again to the control as it is
  now; and the control in view. Otherwise it refuses and says why. `executor.js` then checks the same element again in
  the same step as the action, so nothing can change in between.
- **Click** calls the element's own `click()`. **Type** selects the field's content without reading it and inserts the
  approved text as typing does (an `input` event). It never reads the previous value, never presses Enter and never
  submits the form. **Scroll** moves only the page's own scroller by at most 80% of the viewport height (800 px max),
  after checking how much room is left in that direction. Nested scroll containers are not supported.
- **Script-made events.** These are not real input, so some sites ignore them. The action is reported as *dispatched*,
  not as effective.
- **After the action.** Cloudy captures the page again and shows the controls now on the page, then stops. It does not
  ask the model for another step. The result keeps three things apart: *action dispatched* (or not, and why),
  *effect observed* (only what the new capture shows: a changed control count, a navigation, the new scroll position),
  and *goal verified* (always "no": Cloudy does not judge goals). It does not claim a typed value was verified, because
  values are never read back.
- **Stop** cancels an approved action only before it is dispatched. It cannot undo one that has already run; then it
  only skips the follow-up capture.

### Limits to keep in mind

- The model's choice can be wrong even when the format is valid: a valid ID does not prove relevance. Compare the
  step with your goal and the "controls sent to the model" list.
- Local-model results are a rate, not a guarantee (see Tests).
- Page text and control names are untrusted data; the instructions tell the model to ignore orders found there,
  which helps but is not a complete defense. The code checks above are what stop an obeyed order from being shown as valid.

## Notes

- Stop cancels the browser's request. It does not prove Ollama stopped computing.
- Each request is independent (no conversation history).
- Replies are inserted with `textContent` and never executed.

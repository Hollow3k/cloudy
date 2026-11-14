// Access checks: broad http/https host access, no toolbar-click gate, restricted
// and withheld pages, and the passive access indicator. Runs the real
// sidepanel.js in a fake browser (fake-panel.js). This is NOT the installed
// extension: whether Chrome really grants/withholds access is untested here.
const fs = require("fs");
const path = require("path");
const { load } = require("./fake-panel.js");
const root = path.join(__dirname, "..");
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + String(extra).slice(0, 260) : ""}`);

(async () => {
  // ===== 1. Manifest =====
  const manifestText = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  ok("1: host_permissions = localhost first, then https and http only", JSON.stringify(manifest.host_permissions) === '["http://localhost:11434/*","https://*/*","http://*/*"]', JSON.stringify(manifest.host_permissions));
  ok("1: permissions unchanged (scripting already present, activeTab kept, no tabs)", JSON.stringify(manifest.permissions) === '["sidePanel","activeTab","scripting"]');
  ok("1: no <all_urls>, file://, content_scripts, optional_* or externally_connectable", !/all_urls|file:\/\//.test(manifestText) && !manifest.content_scripts && !manifest.optional_permissions && !manifest.optional_host_permissions && !manifest.externally_connectable);
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  ok("1: UI text no longer says every page needs a toolbar click", !/first click Cloudy's toolbar icon/i.test(html) && /without a toolbar click/.test(html));
  ok("1: README no longer says access comes only from a toolbar click", !/only from a (toolbar )?click|first click Cloudy/i.test(readme));

  const code = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8").replace(/\/\/.*$/gm, "");
  ok("1: no stored 'clicked' flag gates reading", !/toolbarClicked|clickedTab|grantedTab|hasClicked|activated\s*=\s*true/i.test(code));

  // ===== 2. Normal pages are readable with no click =====
  const p = load();
  const A = p.api;
  const state = () => ({ text: p.ids["access-state"].textContent, unavailable: p.ids["access-state"].classes.has("unavailable") });
  const scriptsBefore = () => p.state.scriptCalls.length;
  let tab = { id: 7, url: "https://site.test/page?x=1" };
  p.setTabFn(() => tab);
  p.setAllSites(true);
  p.setScript((o) => [{ result: p.snap("product") }]);

  await p.tick(40);
  ok("2: indicator on panel load: readable, no injection", /this page can be read/.test(state().text) && !state().unavailable && scriptsBefore() === 0, state().text);

  let a = await A.assessActiveTab();
  ok("2: https page: readable", a.state === "readable" && a.tab.id === 7);
  tab = { id: 7, url: "http://plain.test/" };
  a = await A.assessActiveTab();
  ok("2: http page: readable", a.state === "readable");

  tab = { id: 7, url: "https://site.test/page?x=1" };
  p.reply({ status: "insufficient_evidence", answer: "Not in the capture.", citations: [] });
  await p.ask("what is this page?");
  ok("2: Ask about this page works on a normal page with no click (capture ran, request sent)", p.state.scriptCalls.length >= 1 && p.state.fetchCalls.length === 1, p.ids.status.textContent);

  // ===== 3. Restricted pages: unavailable, nothing injected or sent =====
  const restricted = [
    ["chrome:// page", "chrome://extensions/"],
    ["chrome-extension:// page", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html"],
    ["file:// page", "file:///C:/notes.html"],
    ["about:blank", "about:blank"],
    ["view-source:", "view-source:https://site.test/"],
    ["Chrome Web Store (new)", "https://chromewebstore.google.com/detail/x/abc"],
    ["Chrome Web Store (old)", "https://chrome.google.com/webstore/detail/x/abc"],
    ["devtools://", "devtools://devtools/bundled/inspector.html"],
  ];
  for (const [label, url] of restricted) {
    tab = { id: 7, url };
    a = await A.assessActiveTab();
    const kindOk = a.state === "unavailable" && a.kind === "restricted" && /only reads ordinary http or https pages/.test(a.message);
    p.state.scriptCalls.length = 0; p.state.fetchCalls.length = 0;
    await p.ask("what is this page?");
    ok(`3: ${label}: restricted, no injection, no request, error shown`, kindOk && p.state.scriptCalls.length === 0 && p.state.fetchCalls.length === 0 && p.ids.status.isError === true && /ordinary http or https/.test(p.ids.status.textContent) && state().unavailable, JSON.stringify([a.state, a.kind]) + p.ids.status.textContent.slice(0, 80));
  }
  // A look-alike host is not the Web Store.
  tab = { id: 7, url: "https://chromewebstore.google.com.evil.test/" };
  ok("3: look-alike host is not treated as the Web Store", (await A.assessActiveTab()).state === "readable");
  tab = { id: 7, url: "https://chrome.google.com/other" };
  ok("3: chrome.google.com outside /webstore is not restricted by Cloudy", (await A.assessActiveTab()).state === "readable");

  // ===== 4. tab.url missing =====
  tab = { id: 7 };
  p.setAllSites(true);
  a = await A.assessActiveTab();
  ok("4: no tab.url + all-sites access granted -> restricted page", a.state === "unavailable" && a.kind === "restricted");
  p.state.permCalls.length = 0;
  p.setAllSites(false);
  a = await A.assessActiveTab();
  ok("4: no tab.url + access withheld -> no-access, explains Site access and the one-time toolbar click", a.kind === "no-access" && /withholding site access/.test(a.message) && /On all sites/.test(a.message) && /toolbar icon/.test(a.message) && /restricted page/.test(a.message), a.message);
  ok("4: the permission check asks for exactly the two http/https patterns", p.state.permCalls[0] === JSON.stringify({ origins: ["https://*/*", "http://*/*"] }), p.state.permCalls[0]);
  p.state.permThrows = true;
  a = await A.assessActiveTab();
  ok("4: permissions.contains throwing is tolerated (treated as unknown, still no-access)", a.kind === "no-access");
  p.state.permThrows = false;
  tab = null;
  a = await A.assessActiveTab();
  ok("4: no active tab -> no-tab", a.kind === "no-tab");

  // Withheld access: nothing is injected and nothing is sent.
  tab = { id: 7 }; p.setAllSites(false);
  p.state.scriptCalls.length = 0; p.state.fetchCalls.length = 0;
  await p.ask("what is this page?");
  ok("4: withheld access -> clear error, no injection, no request", p.state.scriptCalls.length === 0 && p.state.fetchCalls.length === 0 && p.ids.status.isError === true && /Chrome is withholding site access/.test(p.ids.status.textContent) && /Page access: unavailable/.test(state().text));

  // ===== 5. A real executeScript permission error is still classified =====
  tab = { id: 7, url: "https://site.test/page" }; p.setAllSites(true);
  p.setScript(() => { throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host."); });
  p.state.fetchCalls.length = 0;
  await p.ask("what is this page?");
  ok("5: executeScript 'Cannot access contents' -> no-access message with Site access guidance, no request", p.ids.status.isError === true && /doesn't have access to this tab/.test(p.ids.status.textContent) && /Site access/.test(p.ids.status.textContent) && /toolbar icon/.test(p.ids.status.textContent) && p.state.fetchCalls.length === 0, p.ids.status.textContent);
  p.setScript(() => { throw new Error("Cannot access a chrome:// URL"); });
  await p.ask("what is this page?");
  ok("5: executeScript 'chrome://' error -> restricted message", /doesn't let extensions read/.test(p.ids.status.textContent));

  // ===== 6. Indicator follows tab events; stale context never looks current =====
  p.setScript(() => [{ result: p.snap("product") }]);
  tab = { id: 7, url: "https://site.test/page" }; p.setAllSites(true);
  p.reply({ status: "insufficient_evidence", answer: "n/a", citations: [] });
  await p.ask("what is this page?");
  ok("6: a captured page is on screen", A.getPageContext() !== null && !p.ids["excerpt-details"].hidden);

  const before = scriptsBefore();
  p.state.permCalls.length = 0;
  tab = { id: 8, url: "chrome://extensions/" };
  p.handlers.activated({ tabId: 8 });
  await p.tick(30);
  ok("6: switching to a restricted tab shows unavailable and drops the old capture", state().unavailable && /Page access: unavailable/.test(state().text) && A.getPageContext() === null && p.ids["excerpt-details"].hidden === true && /No page captured/.test(p.ids["page-info"].textContent) && p.ids["excerpt"].textContent === "");
  ok("6: the indicator injected nothing", scriptsBefore() === before);

  tab = { id: 9, url: "https://other.test/" };
  p.handlers.activated({ tabId: 9 });
  await p.tick(30);
  ok("6: switching to a normal tab shows readable again, without capturing anything", /this page can be read/.test(state().text) && !state().unavailable && A.getPageContext() === null && scriptsBefore() === before);

  tab = { id: 9, url: "https://other.test/" };
  p.handlers.updated(9, { title: "new title" });
  p.handlers.updated(9, { favIconUrl: "x" });
  await p.tick(20);
  const callsBefore = p.state.permCalls.length;
  p.handlers.updated(9, { title: "t2" });
  await p.tick(20);
  ok("6: title/favicon updates do not trigger a check", p.state.permCalls.length === callsBefore);

  tab = { id: 9, url: "chrome://settings/" };
  p.handlers.updated(9, { url: "chrome://settings/" });
  await p.tick(30);
  ok("6: navigating the active tab to a restricted URL updates the indicator", state().unavailable);
  tab = { id: 9 }; p.setAllSites(false);
  p.handlers.updated(9, { status: "complete" });
  await p.tick(30);
  ok("6: a withheld tab (no url) shows unavailable with the withheld wording", state().unavailable && /withholding site access/.test(state().text));
  p.setAllSites(true); tab = { id: 9, url: "https://other.test/" };
  p.handlers.permAdded && p.handlers.permAdded();
  await p.tick(30);
  ok("6: granting access while the panel is open refreshes the indicator", !state().unavailable);

  // Proposal on screen is invalidated when the tab becomes unreadable.
  const fx = p.useAction("act_store");
  p.setTabFn(() => tab);
  p.setScript((o) => (o.func && o.func.name === "captureActionTargets" ? [{ result: fx.targets }] : [{ result: fx.snapshot }]));
  tab = { id: 7, url: "https://site.test/page" };
  p.state.fetchImpl = async () => ({ ok: true, json: async () => {
    const c = A.getActionContext(); let id = null; for (const r of c.records.values()) if (r.name === "Sale") id = r.id;
    return { response: JSON.stringify({ rationale: "r", action: "click", target_id: id, text: "", direction: "", question: "", reason: "" }), prompt_eval_count: 1, total_duration: 1 };
  } });
  await p.suggest("go to the sale page");
  ok("6: a proposal is on screen", !p.actionView().hidden && A.getActionContext() !== null);
  tab = { id: 7, url: "chrome://newtab/" };
  p.handlers.updated(7, { url: "chrome://newtab/" });
  await p.tick(30);
  const av = p.actionView();
  ok("6: the proposal is cleared when its tab becomes unreadable", av.rejected === true && av.action === "" && A.getActionContext() === null && /was cleared/.test(av.banner));

  // Suggest mode follows the same gate.
  p.state.scriptCalls.length = 0; p.state.fetchCalls.length = 0;
  await p.suggest("go to the sale page");
  const sv = p.actionView();
  ok("6: Suggest next action on a restricted page: unavailable, no injection, no request", p.state.scriptCalls.length === 0 && p.state.fetchCalls.length === 0 && sv.isError === true && /ordinary http or https/.test(sv.status), sv.status);

  // ===== 7. Guarantees unchanged =====
  ok("7: no execution paths added to sidepanel.js", !/\.click\(|chrome\.tabs\.(update|create|remove|reload)|chrome\.debugger|chrome\.windows|window\.open|scrollTo\(|insertText|execCommand/.test(code));
  ok("7: only chrome.permissions.contains is used for the check; no request/remove", /chrome\.permissions\.contains/.test(code) && !/permissions\.(request|remove)\(/.test(code));
  ok("7: no automatic capture on tab events (handlers only call the passive refresh)", !/onActivated[\s\S]{0,400}captureActivePage|onUpdated[\s\S]{0,400}captureActivePage|refreshAccessState[\s\S]{0,400}executeScript/.test(code));
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  ok("7: background.js behaviour unchanged (action click opens the panel)", /openPanelOnActionClick: false/.test(bg) && /action\.onClicked\.addListener/.test(bg) && /sidePanel\s*\.open\(/.test(bg));

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`access tests: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

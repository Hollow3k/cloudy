// Service worker. Its only job: open the side panel when the toolbar icon
// is clicked.
//
// Why not setPanelBehavior({ openPanelOnActionClick: true })?
// Chrome does NOT grant the "activeTab" permission when the panel is opened
// that way. By handling chrome.action.onClicked ourselves, the click counts as
// a normal action click, which DOES grant temporary access to that tab. The
// side panel's "Ask about this page" button relies on that access.

// An older version of Cloudy set this to true and Chrome remembers it, so turn
// it off explicitly. (Otherwise onClicked would never fire.)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error("Could not set side panel behavior:", error));

chrome.action.onClicked.addListener((tab) => {
  // Call open() immediately: it must run while the click's user gesture is
  // still valid, so no `await` before it.
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((error) => console.error("Could not open side panel:", error));
});

// Service worker. Its only job in this milestone: make a click on the
// toolbar icon open the side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Could not set side panel behavior:", error));

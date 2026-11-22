// Sidebar Agent for Z.ai: service worker.
// It only opens the side panel when the toolbar icon is clicked. All requests are made by the panel
// itself, directly to api.z.ai with the user's own API key.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel behavior failed:", e));

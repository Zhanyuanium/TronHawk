// Generic Window Controls Overlay (WCO) elimination compat adapter.
//
// Many Electron apps (VS Code, WorkBuddy, and any app that opts into a custom
// titlebar) create their window with titleBarStyle: "hidden" + a titleBarOverlay
// option, so the native min/max/close buttons are drawn by Electron/Chromium over
// the web content rather than by the app. Those buttons are NOT reachable from the
// renderer (the overlay region is off-limits to DOM), so a renderer CSS/JS plugin
// cannot restyle them. This adapter opts into the runtime's generic `onWindowOptions`
// seam: every `new BrowserWindow(opts)` issued by the target main process after
// adapter selection has its options rewritten before the real constructor runs —
// dropping `titleBarOverlay` and forcing `titleBarStyle: "hidden"`, which yields a
// plain hidden-titlebar window with NO native WCO buttons.
//
// No custom titlebar controls are introduced here; WCO elimination only. The
// adapter itself must never require("electron") (src/adapters.js purity requirement);
// the window-construction interception lives in the runtime's start() (src/index.js),
// which calls adapters.applyWindowOptions(adapter, opts) in front of every
// `new BrowserWindow(...)`.
//
// Modeled after apps/test-app so the mechanism is exercised end-to-end against the
// deterministic test app (which simulates a WCO window on Windows). The match is
// intentional: the test app is the WCO verification host for this mechanism.
const { makeSelectorGate } = require("./gate");

module.exports = {
  id: "wco",
  apiVersion: 1,
  matches(appInfo) {
    if (!appInfo || typeof appInfo !== "object") return false;
    return (
      appInfo.name === "tronhawk-test-app" || appInfo.packageJsonName === "tronhawk-test-app"
    );
  },
  // Window construction hook (optional): called before the target main process constructs a
  // BrowserWindow and may return modified options. Here it eliminates WCO: drops titleBarOverlay
  // and forces titleBarStyle: "hidden". No self-drawn titlebar controls are introduced.
  onWindowOptions(opts) {
    const next = Object.assign({}, opts || {});
    delete next.titleBarOverlay;
    next.titleBarStyle = "hidden";
    return next;
  },
  renderer: {
    // Path A timing seam (same as the example adapter): the test-app's renderer mounts #late-root
    // ~1.2s after DOMContentLoaded, so gate injection on that element appearing. Required because
    // this adapter is the one that wins selection for the test app.
    gate(win, ready) {
      const contents = win && win.contents;
      if (!contents || typeof contents.executeJavaScript !== "function") {
        ready();
        return;
      }
      const probe = () =>
        contents
          .executeJavaScript("!!document.querySelector('#late-root')")
          .then((value) => !!value);
      makeSelectorGate(probe, ready, { intervalMs: 200, timeoutMs: 5000 });
    },
  },
};

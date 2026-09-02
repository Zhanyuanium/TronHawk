// Obsidian compat adapter.
//
// Path I (ADR 0004, merged asar) fixed the injection layer so the app's module resolution works
// (Obsidian's `@electron/remote` now resolves). Path A adds the renderer-timing seam: instead of
// the runtime's fixed `did-finish-load` trigger, `renderer.gate(win, ready)` polls for the
// `.workspace` root — Obsidian's own "app UI is ready" signal — and calls `ready()` only once it
// is mounted, so CSS/renderer injection lands after the workspace actually exists.
//
// The Gate 0 observation probe was removed: the stub-asar-hijack diagnosis is confirmed and the
// probe no longer earns its keep. For now the adapter only declares its matcher and the
// renderer gate; `onBootstrap` is intentionally absent (nothing to do pre-load yet, and the host
// fail-opens if it is missing).
const { makeSelectorGate } = require("./gate");

module.exports = {
  id: "obsidian",
  apiVersion: 1,
  matches(appInfo) {
    // Strong Obsidian signals only. Never throws on missing fields.
    if (!appInfo || typeof appInfo !== "object") return false;
    if (appInfo.name === "obsidian" || appInfo.packageJsonName === "obsidian") return true;
    return (
      typeof appInfo.exeBasename === "string" &&
      appInfo.exeBasename.toLowerCase() === "obsidian.exe"
    );
  },
  renderer: {
    gate(win, ready) {
      const contents = win && win.contents;
      if (!contents || typeof contents.executeJavaScript !== "function") {
        ready();
        return;
      }
      const probe = () =>
        contents
          .executeJavaScript("!!document.querySelector('.workspace')")
          .then((value) => !!value);
      makeSelectorGate(probe, ready, { intervalMs: 200, timeoutMs: 15000 });
    },
  },
};

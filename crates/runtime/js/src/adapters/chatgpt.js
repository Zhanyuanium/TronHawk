// ChatGPT (OpenAI Codex Desktop) compat adapter (ADR 0005).
//
// The app is MSIX-packaged (OpenAI.Codex, "owl" Electron fork). Native injection via AUMID
// activation + race-attach is handled by the injector layer (not here). The adapter detects the
// app, logs diagnostics, and provides the renderer-timing gate: it waits for ChatGPT's UI root
// (#__next) — its "app UI is ready" signal — before the runtime injects CSS/renderer plugins.
const { makeSelectorGate } = require("./gate");

module.exports = {
  id: "chatgpt",
  apiVersion: 1,
  matches(appInfo) {
    // Strong ChatGPT/Codex signals only. Never throws on missing fields.
    if (!appInfo || typeof appInfo !== "object") return false;
    // Primary: the real package.json name from the merged asar (ADR 0005).
    if (appInfo.packageJsonName === "openai-codex-electron") return true;
    // Fallback: exe name (ChatGPT and the bundled Codex IDE share the package/asar).
    return (
      typeof appInfo.exeBasename === "string" &&
      /^(chatgpt|codex)\.exe$/i.test(appInfo.exeBasename)
    );
  },
  onBootstrap(ctx) {
    // Diagnostics only; fail-open. Emergency levers (updater no-op / realpathSync patch) are
    // env-gated and OFF by default — add only if a specific issue recurs.
    const log = (level, message) => {
      try {
        if (typeof ctx.log === "function") ctx.log(level, message);
      } catch (_e) {
        // ignore
      }
    };
    try {
      const ai = ctx.appInfo || {};
      log(
        "info",
        "chatgpt:adapter name=" + (ai.name || "?") +
          " pkg=" + (ai.packageJsonName || "?") +
          " exe=" + (ai.exeBasename || "?") +
          " electron=" + (ai.electronVersion || "?"),
      );
      const app = ctx.app;
      if (app && typeof app.getVersion === "function") {
        log("info", "chatgpt:adapter version=" + app.getVersion());
      }
      if (app && typeof app.getPath === "function") {
        try {
          log("info", "chatgpt:adapter userData=" + app.getPath("userData"));
        } catch (_e) {
          // ignore
        }
      }
    } catch (e) {
      log("error", "chatgpt:adapter onBootstrap failed: " + (e && e.message ? e.message : e));
    }
  },
  renderer: {
    gate(win, ready) {
      const contents = win && win.contents;
      if (!contents || typeof contents.executeJavaScript !== "function") {
        ready();
        return;
      }
      // ChatGPT's main window is a Next.js SPA; wait for #__next before injecting so CSS lands
      // after the UI is mounted. The bounded-timeout backstop (makeSelectorGate) ensures injection
      // is never lost if a non-#__next window is tracked.
      const probe = () =>
        contents.executeJavaScript("!!document.querySelector('#__next')").then((value) => !!value);
      makeSelectorGate(probe, ready, { intervalMs: 200, timeoutMs: 20000 });
    },
  },
};

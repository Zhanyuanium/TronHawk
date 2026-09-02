// Model compat adapter for the TronHawk test app.
//
// Phase A generic interface (see src/adapters.js):
//   matches(appInfo)  -> truthy/falsy   (required)
//   onBootstrap(ctx)  -> void           (optional)
//   renderer.gate(win, ready)           (optional — Path A timing seam)
//
// `ctx` is host-provided: { app, appInfo, protocol, log }. Adapters never import electron
// themselves — everything they need arrives via ctx. No protocol hooks yet (Phase B).
//
// renderer.gate exercises the Path A seam against the test-app's late-mount consumer: the
// renderer mounts `#late-root` ~1.2s after DOMContentLoaded (apps/test-app/src/renderer.js), so
// CSS/renderer injection is gated on that element appearing rather than on did-finish-load.
const { makeSelectorGate } = require("./gate");

module.exports = {
  id: "example",
  apiVersion: 1,
  matches(appInfo) {
    // The real test-app reports name "tronhawk-test-app" (apps/test-app/package.json). appInfo.name
    // is app.getName(); appInfo.packageJsonName is the best-effort package.json read — match on
    // either so selection survives whichever the app actually reports.
    return (
      appInfo.name === "tronhawk-test-app" || appInfo.packageJsonName === "tronhawk-test-app"
    );
  },
  onBootstrap(ctx) {
    ctx.log("info", "example adapter matched: " + (ctx.appInfo && ctx.appInfo.name));
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
          .executeJavaScript("!!document.querySelector('#late-root')")
          .then((value) => !!value);
      makeSelectorGate(probe, ready, { intervalMs: 200, timeoutMs: 5000 });
    },
  },
};

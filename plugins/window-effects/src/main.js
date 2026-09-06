// Window Effects — main-process entry (CommonJS, loaded directly by the QuickJS host).
// A main-process plugin that softens new windows as they open. Uses only the
// implemented `ctx.window` surface (onCreated / setOpacity).
// setVibrancy / setMica are NOT used here: they are not wired into the runtime yet.
// The runtime reads module.exports.activate / module.exports.deactivate;
// do NOT convert this file to ESM (export default). The TypeScript source
// src/main.ts is kept alongside for type-checking only and is not the
// runtime entry.
/** @type {import("@tronhawk/sdk").PluginModule<import("@tronhawk/sdk").MainContext>} */
module.exports = {
  activate(ctx) {
    ctx.logger.info("window-effects activated");
    ctx.window.onCreated((win) => {
      ctx.window.setOpacity(win, 0.9);
    });
  },
  deactivate(ctx) {
    ctx.logger.info("window-effects deactivated");
  },
};

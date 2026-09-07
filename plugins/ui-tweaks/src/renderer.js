// UI Tweaks — renderer entry (CommonJS, loaded directly by the QuickJS host).
// A renderer plugin that renames the window title and ships a small page
// theme. The theme is delivered as data via manifest.json's entry.css
// (style.css); the renderer script only uses the implemented ctx.script API
// (setDocumentTitle) and the host-attributed logger. It does NOT call
// ctx.css.insert/remove — that host API is not yet wired (see PLUGIN-SDK.md).
// The runtime reads module.exports.activate / module.exports.deactivate;
// do NOT convert this file to ESM (no default-export form). The TypeScript
// source src/renderer.ts is kept alongside for type-checking only and is not
// the runtime entry. Requires the renderer.script execution-gate permission
// (declared in manifest.json).
// Type: PluginModule<RendererContext> (see src/renderer.ts for full types).
module.exports = {
  activate(ctx) {
    ctx.logger.info("ui-tweaks activated");
    ctx.script.setDocumentTitle("TronHawk - tweaked");
  },
  deactivate(ctx) {
    ctx.logger.info("ui-tweaks deactivated");
  },
};

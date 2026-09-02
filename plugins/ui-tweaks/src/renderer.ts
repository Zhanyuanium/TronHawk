// UI Tweaks — a renderer plugin that renames the window title and ships a small
// page theme. The theme is delivered as data via manifest.json's entry.css
// (style.css); the renderer script only uses the implemented ctx.script API
// (setDocumentTitle) and the host-attributed logger. It does NOT call
// ctx.css.insert/remove — that host API is not yet wired (see PLUGIN-SDK.md).
import type { PluginModule, RendererContext } from "@tronhawk/sdk";

const plugin: PluginModule<RendererContext> = {
  activate(ctx: RendererContext) {
    ctx.logger.info("ui-tweaks activated");
    ctx.script.setDocumentTitle("TronHawk - tweaked");
  },
  deactivate(ctx: RendererContext) {
    ctx.logger.info("ui-tweaks deactivated");
  },
};

export default plugin;

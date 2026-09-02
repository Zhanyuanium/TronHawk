// Window Effects — a main-process plugin that softens new windows as they open.
// Uses only the implemented `ctx.window` surface (onCreated / setOpacity).
// setVibrancy / setMica are NOT used here: they are not wired into the runtime yet.
import type { MainContext, PluginModule } from "@tronhawk/sdk";

const plugin: PluginModule<MainContext> = {
  activate(ctx: MainContext) {
    ctx.logger.info("window-effects activated");
    ctx.window.onCreated((win) => {
      ctx.window.setOpacity(win, 0.9);
    });
  },
  deactivate(ctx: MainContext) {
    ctx.logger.info("window-effects deactivated");
  },
};

export default plugin;

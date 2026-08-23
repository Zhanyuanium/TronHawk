import type { PluginModule, RendererContext } from "@tronhawk/sdk";

let styleId: string | undefined;

const plugin: PluginModule<RendererContext> = {
  activate(ctx: RendererContext) {
    ctx.logger.info("hello-world activated");
    styleId = ctx.css.insert(
      "body { background: #111 !important; color: #eee !important; }",
    );
  },
  deactivate(ctx: RendererContext) {
    if (styleId) {
      ctx.css.remove(styleId);
      styleId = undefined;
    }
    ctx.logger.info("hello-world deactivated");
  },
};

export default plugin;

import type { PluginModule, RendererContext } from "@tronhawk/sdk";

let styleId: string | undefined;

const plugin: PluginModule<RendererContext> = {
  async activate(ctx: RendererContext) {
    ctx.logger.info("hello-world activated");
    styleId = await ctx.css.insert(
      "body { background: #111 !important; color: #eee !important; }",
    );
  },
  async deactivate(ctx: RendererContext) {
    if (styleId) {
      await ctx.css.remove(styleId);
      styleId = undefined;
    }
    ctx.logger.info("hello-world deactivated");
  },
};

export default plugin;

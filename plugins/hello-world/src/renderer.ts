import type { RendererContext } from "@tronhawk/sdk";

export default {
  activate(ctx: RendererContext) {
    ctx.logger.info("hello-world activated");
    ctx.css.insert("body { background: #111 !important; color: #eee !important; }");
  },
  deactivate(ctx: RendererContext) {
    ctx.logger.info("hello-world deactivated");
  },
};

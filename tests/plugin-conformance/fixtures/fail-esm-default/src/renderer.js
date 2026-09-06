// Conformance negative: ESM default export is never read by the host.
export default {
  activate(ctx) {
    ctx.logger.info("never-loaded");
  },
  deactivate(ctx) {},
};

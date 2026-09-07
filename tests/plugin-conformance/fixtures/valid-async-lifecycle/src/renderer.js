// Conformance: async activate/deactivate drain to fulfillment (ADR 0008).
module.exports = {
  activate(ctx) {
    ctx.logger.info("async-on-start");
    return Promise.resolve().then(() => {
      ctx.logger.info("async-on-end");
    });
  },
  deactivate(ctx) {
    return Promise.resolve().then(() => {
      ctx.logger.info("async-off-ran");
    });
  },
};

// Conformance: valid main-process entry (granted ctx only).
module.exports = {
  activate(ctx) {
    ctx.logger.info("valid-main-on");
    ctx.window.onCreated((win) => {
      ctx.logger.info("valid-main-window:" + win);
    });
  },
  deactivate(ctx) {
    ctx.logger.info("valid-main-off");
  },
};

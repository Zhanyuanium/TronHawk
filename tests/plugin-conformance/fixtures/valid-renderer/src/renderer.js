// Conformance: valid renderer entry (granted ctx only).
module.exports = {
  activate(ctx) {
    ctx.logger.info("valid-renderer-on");
    ctx.script.setDocumentTitle("TronHawk - conformance");
  },
  deactivate(ctx) {
    ctx.logger.info("valid-renderer-off");
  },
};

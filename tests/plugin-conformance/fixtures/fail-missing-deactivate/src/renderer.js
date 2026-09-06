// Conformance negative: no deactivate export (contract requires both hooks).
module.exports = {
  activate(ctx) {
    ctx.logger.info("only-activate");
  },
};

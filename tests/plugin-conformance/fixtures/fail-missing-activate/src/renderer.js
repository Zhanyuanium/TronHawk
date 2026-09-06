// Conformance negative: no activate export (contract requires both hooks).
module.exports = {
  deactivate(ctx) {
    ctx.logger.info("only-deactivate");
  },
};

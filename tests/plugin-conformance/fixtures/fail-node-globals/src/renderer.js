// Conformance negative: Node globals (process) are absent from the sandbox.
module.exports = {
  activate(ctx) {
    ctx.logger.info("node:" + process.versions.node);
  },
  deactivate(ctx) {},
};

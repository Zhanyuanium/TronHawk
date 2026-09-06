// Conformance: network.request WITHOUT the grant rejects catchably;
// the lifecycle still passes (denied surface, not a load failure).
module.exports = {
  activate(ctx) {
    return ctx.network.request({ url: "https://example.com/" }).then(
      () => ctx.logger.info("UNEXPECTED-RESOLVE"),
      (e) => ctx.logger.info("DENIED:" + (e && e.message ? e.message : e)),
    );
  },
  deactivate(ctx) {},
};

// Conformance: network.request WITH the network.access grant resolves.
module.exports = {
  activate(ctx) {
    return ctx.network.request({ url: "https://example.com/" }).then((res) => {
      ctx.logger.info("NET-STATUS:" + res.status);
    });
  },
  deactivate(ctx) {},
};

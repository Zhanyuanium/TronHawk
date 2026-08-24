// Dark Script — a renderer plugin that runs page JS via the sandboxed bridge.
module.exports = {
  activate(ctx) {
    ctx.script.execute(
      "document.title = 'TRONHAWK-INJECTED'; document.body.style.background = '#123456';",
    );
  },
  deactivate() {},
};

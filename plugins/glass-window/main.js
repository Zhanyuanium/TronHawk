// Glass Window — a main-process plugin that lowers the window opacity on creation.
module.exports = {
  activate(ctx) {
    ctx.window.onCreated((w) => {
      ctx.window.setOpacity(w, 0.5);
    });
  },
  deactivate() {},
};

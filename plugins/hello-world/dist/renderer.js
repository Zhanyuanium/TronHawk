// Built from src/renderer.ts (Phase 1 MVP: hand-written CommonJS equivalent).
module.exports = {
  activate(ctx) {
    ctx.css.insert("body { background: #111 !important; color: #eee !important; }");
  },
  deactivate() {},
};

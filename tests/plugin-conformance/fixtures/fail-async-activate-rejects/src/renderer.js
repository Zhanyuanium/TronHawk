// Conformance negative: a rejected async activate fails closed.
module.exports = {
  activate(ctx) {
    return Promise.reject(new Error("boom-async-conformance"));
  },
  deactivate(ctx) {},
};

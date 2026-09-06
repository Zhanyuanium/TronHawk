// Conformance negative: sync deactivate must return undefined.
module.exports = {
  activate(ctx) {},
  deactivate(ctx) {
    return { not: "void" };
  },
};

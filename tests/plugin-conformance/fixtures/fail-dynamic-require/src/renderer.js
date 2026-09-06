// Conformance negative: `require` does not exist in QuickJS; bundles must
// be single-file with no require leftovers.
const fs = require("fs");
module.exports = {
  activate(ctx) {
    ctx.logger.info("never-loaded:" + fs);
  },
  deactivate(ctx) {},
};

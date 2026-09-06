// Conformance negative: bare ESM import cannot load as a classic script.
import { thing } from "somewhere";
module.exports = {
  activate(ctx) {
    ctx.logger.info("never-loaded:" + thing);
  },
  deactivate(ctx) {},
};

// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
// `originalAsar` is the path to the target's real app.asar (presented as `_app.asar`).
const path = require("path");
const fs = require("fs");
const os = require("os");

module.exports = function bootstrap(originalAsar) {
  const log = (msg) => {
    console.log("[tronhawk] " + msg);
    fs.appendFileSync(
      path.join(os.tmpdir(), "tronhawk-bootstrap.log"),
      msg + "\n",
    );
  };

  log("injected into main process; original asar=" + originalAsar);

  // TODO: establish comms with Core via local-socket JSON-RPC (crates/ipc).

  // Transparent injection: load the original app so it starts normally.
  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    const main = pkg.main || "index.js";
    log("loading original app main: " + main);
    require(path.join(originalAsar, main));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e));
  }
};

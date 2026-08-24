// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
//
// Injector responsibility (docs/AGENTS.md): enter process, establish comms with Core,
// and load the trusted Runtime. NO plugin logic lives here.
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const LOG = path.join(os.tmpdir(), "tronhawk-bootstrap.log");
function log(msg) {
  console.log("[tronhawk] " + msg);
  fs.appendFileSync(LOG, msg + "\n");
}

function getPlugin(port, secret) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        JSON.stringify({
          version: "0.1",
          id: 1,
          method: "getPlugin",
          params: {},
          secret,
        }) + "\n",
      );
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
  });
}

module.exports = function bootstrap(originalAsar) {
  log("injected; electron=" + process.versions.electron);

  const port = parseInt(process.env.TRONHAWK_IPC_PORT || "17777", 10);
  const secret = process.env.TRONHAWK_IPC_SECRET || "";
  log("connecting to Core on port " + port);

  const { app } = require("electron");
  const runtime = require(path.join(__dirname, "runtime.js"));

  // Register the Runtime's window hooks early, before the app creates its windows.
  runtime.start(app);

  // Establish comms and hand the execution plan to the Runtime.
  getPlugin(port, secret)
    .then((resp) => {
      if (resp.error) {
        log("Core error: " + JSON.stringify(resp.error));
        return;
      }
      const plugin = resp.result;
      if (!plugin || typeof plugin !== "object" || typeof plugin.id !== "string") {
        log("invalid plugin payload from Core; ignoring");
        return;
      }
      log("received plugin: " + plugin.id + " v" + plugin.version);
      runtime.setPlugin(plugin);
    })
    .catch((e) => log("getPlugin failed: " + (e && e.message ? e.message : e)));

  // Load the original app (transparent injection).
  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    require(path.join(originalAsar, pkg.main || "index.js"));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e));
  }
};

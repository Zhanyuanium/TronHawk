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
const MAX_LOG = 256 * 1024;
function log(msg) {
  console.log("[tronhawk] " + msg);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) {
      fs.truncateSync(LOG, 0);
    }
    fs.appendFileSync(LOG, msg + "\n");
  } catch (e) {
    /* best-effort logging */
  }
}

function getExecutionPlan(port, secret) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        JSON.stringify({
          version: "0.1",
          id: 1,
          method: "getExecutionPlan",
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

  const { app } = require("electron");
  const runtime = require(path.join(__dirname, "runtime.js"));

  // Register the Runtime's window hooks early, before the app creates its windows.
  runtime.start(app);

  const apply = (resp) => {
    if (resp.error) {
      log("Core error: " + JSON.stringify(resp.error));
      return;
    }
    const plan = resp.result;
    if (!plan || !Array.isArray(plan.plugins)) {
      log("invalid plan payload from Core; ignoring");
      return;
    }
    runtime.applyPlan(plan);
  };

  let polling = false;
  const poll = () => {
    if (polling) return;
    polling = true;
    getExecutionPlan(port, secret)
      .then(apply)
      .catch(() => {})
      .then(() => {
        polling = false;
      });
  };

  poll();
  setInterval(poll, 2000);

  // Load the original app (transparent injection).
  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    require(path.join(originalAsar, pkg.main || "index.js"));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e));
  }
};

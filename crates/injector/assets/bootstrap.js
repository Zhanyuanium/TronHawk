// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
//
// Phase 1: connects to Core over IPC, fetches the plugin, and injects its renderer
// entry into the app's renderer with a minimal `ctx` runtime.
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const LOG = path.join(os.tmpdir(), "tronhawk-bootstrap.log");
function log(msg) {
  console.log("[tronhawk] " + msg);
  fs.appendFileSync(LOG, msg + "\n");
}

function getPlugin(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        JSON.stringify({ version: "0.1", id: 1, method: "getPlugin", params: {} }) +
          "\n",
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
  log("connecting to Core on port " + port);

  const { app } = require("electron");
  let plugin = null;

  app.on("web-contents-created", (_e, contents) => {
    let attempts = 0;
    const inject = () => {
      if (!plugin || !plugin.renderer) {
        if (attempts < 20) {
          attempts += 1;
          setTimeout(inject, 500);
        }
        return;
      }

      // Build the renderer runtime: a minimal `ctx` (css.insert) + the plugin source.
      const built =
        "(function () {" +
        "  const ctx = {" +
        "    css: {" +
        "      insert: function (css) {" +
        "        var s = document.createElement('style');" +
        "        s.setAttribute('data-tronhawk', " +
        JSON.stringify(plugin.id) +
        ");" +
        "        s.textContent = css;" +
        "        document.head.appendChild(s);" +
        "        return 'tronhawk://" +
        plugin.id +
        "/style-1';" +
        "      }," +
        "      remove: function () {}" +
        "    }" +
        "  };" +
        "  const module = { exports: {} };" +
        plugin.renderer +
        "  if (module.exports.activate) module.exports.activate(ctx);" +
        "})();";

      contents
        .executeJavaScript(built)
        .then(() =>
          contents.executeJavaScript(
            "getComputedStyle(document.body).backgroundColor",
          ),
        )
        .then((bg) => log("plugin injected; body backgroundColor=" + bg))
        .catch((e) => log("inject failed: " + (e && e.message ? e.message : e)));
    };
    contents.on("did-finish-load", inject);
  });

  getPlugin(port)
    .then((resp) => {
      if (resp.error) {
        log("Core error: " + JSON.stringify(resp.error));
        return;
      }
      plugin = resp.result;
      log("received plugin: " + plugin.id + " v" + plugin.version);
    })
    .catch((e) => log("getPlugin failed: " + (e && e.message ? e.message : e)));

  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    require(path.join(originalAsar, pkg.main || "index.js"));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e));
  }
};

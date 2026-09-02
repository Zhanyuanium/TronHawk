// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
//
// Injector responsibility (docs/AGENTS.md): enter process, establish comms with Core,
// and load the trusted Runtime. NO plugin logic lives here.
const path = require("path");
const net = require("net");

const MAX_QUEUED_LOGS = 256;
const MAX_LOG_BATCH = 16;
const MAX_LOG_MESSAGE_BYTES = 1024;

function boundedMessage(value) {
  const message = typeof value === "string" ? value : String(value);
  if (Buffer.byteLength(message, "utf8") <= MAX_LOG_MESSAGE_BYTES) return message;
  const suffix = "… [truncated]";
  const budget = MAX_LOG_MESSAGE_BYTES - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = message.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(message.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  return message.slice(0, low) + suffix;
}

let nextId = 1;

function request(port, secret, method, params, timeout = 5000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        JSON.stringify({
          version: "0.1",
          id,
          method,
          params,
          secret,
        }) + "\n",
      );
    });
    sock.setTimeout(timeout, () => {
      sock.destroy();
      reject(new Error("ipc timeout"));
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.length > 256 * 1024) {
        sock.destroy();
        reject(new Error("ipc response too large"));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.destroy();
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          if (!resp || resp.version !== "0.1" || resp.id !== id || resp.error) {
            reject(new Error(resp && resp.error ? JSON.stringify(resp.error) : "invalid IPC response"));
            return;
          }
          resolve(resp.result);
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
  });
}

function getExecutionPlan(port, secret) {
  const id = nextId;
  return request(port, secret, "getExecutionPlan", {}).then((result) => ({
    id,
    resp: { version: "0.1", id, result },
  }));
}

module.exports = function bootstrap(originalAsar) {
  const port = parseInt(process.env.TRONHAWK_IPC_PORT || "17777", 10);
  const secret = process.env.TRONHAWK_IPC_SECRET || "";
  const logQueue = [];
  let droppedLogs = 0;
  let deliveringLogs = false;
  let logRetryTimer = null;
  let logRetryMs = 250;

  const consoleFallback = (stream, event) => {
    const prefix = stream === "plugin" ? `[tronhawk:${event.pluginId}]` : "[tronhawk]";
    const output = event.level === "error" ? console.error : event.level === "warn" ? console.warn : console.log;
    output(prefix + " " + event.message);
  };

  const scheduleDelivery = (delay = 0) => {
    if (deliveringLogs || logRetryTimer || logQueue.length === 0) return;
    logRetryTimer = setTimeout(() => {
      logRetryTimer = null;
      deliverLogs();
    }, delay);
  };

  const enqueueLog = (stream, event) => {
    consoleFallback(stream, event);
    if (logQueue.length >= MAX_QUEUED_LOGS) {
      logQueue.shift();
      droppedLogs += 1;
    }
    logQueue.push({ stream, event });
    scheduleDelivery();
  };

  const runtimeLog = (level, message) =>
    enqueueLog("runtime", { level, message: boundedMessage(message) });
  const pluginLog = (pluginId, level, message) =>
    enqueueLog("plugin", {
      pluginId,
      level,
      message: boundedMessage(message),
    });

  function deliverLogs() {
    if (deliveringLogs || logQueue.length === 0) return;
    deliveringLogs = true;
    const stream = logQueue[0].stream;
    const selected = logQueue.filter((item) => item.stream === stream).slice(0, MAX_LOG_BATCH);
    const events = selected.map((item) => item.event);
    const method = stream === "plugin" ? "appendPluginLogs" : "appendRuntimeLogs";
    request(port, secret, method, { events })
      .then(() => {
        for (const item of selected) {
          const index = logQueue.indexOf(item);
          if (index !== -1) logQueue.splice(index, 1);
        }
        logRetryMs = 250;
        if (droppedLogs > 0) {
          const count = droppedLogs;
          droppedLogs = 0;
          logQueue.unshift({
            stream: "runtime",
            event: { level: "warn", message: `Logging recovered after dropping ${count} event(s)` },
          });
        }
      })
      .catch((e) => {
        // Delivery failures only use the fallback: feeding them into this queue would recurse.
        console.warn("[tronhawk] log delivery failed: " + boundedMessage(e && e.message ? e.message : e));
        logRetryMs = Math.min(logRetryMs * 2, 30000);
      })
      .then(() => {
        deliveringLogs = false;
        scheduleDelivery(logRetryMs);
      });
  }

  const log = (msg, level = "info") => runtimeLog(level, msg);
  log("injected; electron=" + process.versions.electron);

  const { app } = require("electron");
  const runtime = require(path.join(__dirname, "runtime.js"));

  runtime.start(app, { runtimeLog, pluginLog });

  const apply = ({ id, resp }) => {
    if (!resp || typeof resp !== "object") {
      log("invalid IPC response; ignoring", "warn");
      return;
    }
    if (resp.version !== "0.1") {
      log("IPC response version mismatch; ignoring", "warn");
      return;
    }
    if (resp.id !== id) {
      log("IPC response id mismatch; ignoring", "warn");
      return;
    }
    if (resp.error) {
      log("Core error: " + JSON.stringify(resp.error), "error");
      return;
    }
    const plan = resp.result;
    if (!plan || !Array.isArray(plan.plugins)) {
      log("invalid plan payload from Core; ignoring", "warn");
      return;
    }
    runtime.applyPlan(plan);
  };

  let polling = false;
  let lastError = null;
  const poll = () => {
    if (polling) return;
    polling = true;
    getExecutionPlan(port, secret)
      .then((result) => {
        if (lastError !== null) {
          log("Core reconnected");
          lastError = null;
        }
        apply(result);
      })
      .catch((e) => {
        const msg = e && e.message ? e.message : String(e);
        if (lastError !== msg) {
          log("poll failed: " + msg, "warn");
          lastError = msg;
        }
      })
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
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e), "error");
  }
};

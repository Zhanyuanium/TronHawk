// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
//
// Injector responsibility (docs/AGENTS.md): enter process, establish comms with Core,
// and load the trusted Runtime. NO plugin logic lives here — and the Runtime owns the
// plan polling/application loop. This file only builds the IPC transport (connect, frame,
// send) plus the bounded log delivery queue, then hands the transport to the Runtime.
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

// Raw IPC exchange: open one connection per request, write the framed JSON-RPC request, and
// resolve with the parsed response envelope. Frame-level validation only (newline frame, size
// cap, JSON parse). Envelope contract checks (version/id/result/error) belong to each consumer:
// the Runtime's plan loop owns them; the log delivery queue below treats any bad envelope as a
// delivery failure.
function sendIpc(port, secret, id, method, params, timeout = 5000) {
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
      // Match the wire frame limit used by the Rust client (crates/ipc MAX_FRAME_SIZE).
      if (buf.length > 64 * 1024) {
        sock.destroy();
        reject(new Error("ipc response too large"));
        return;
      }
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

// Transport seam handed to the Runtime. `request(method, params, { timeout })` resolves to
// `{ id, envelope }` so the Runtime can validate `envelope.id` against the id that was sent.
function buildTransport(port, secret) {
  let nextId = 1;
  const request = (method, params, options = {}) => {
    const id = nextId++;
    const timeout = options && options.timeout ? options.timeout : 5000;
    return sendIpc(port, secret, id, method, params, timeout).then((envelope) => ({ id, envelope }));
  };
  return { request };
}

module.exports = function bootstrap(originalAsar) {
  const port = parseInt(process.env.TRONHAWK_IPC_PORT || "17777", 10);
  const secret = process.env.TRONHAWK_IPC_SECRET || "";
  const { request } = buildTransport(port, secret);
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
    request(method, { events })
      .then(({ id, envelope }) => {
        // Log delivery is transport; a Core error or malformed envelope means the events were not
        // durably accepted, so treat it like any other delivery failure and retry.
        if (!envelope || typeof envelope !== "object" || envelope.version !== "0.1" || envelope.id !== id || envelope.error) {
          throw new Error(envelope && envelope.error ? JSON.stringify(envelope.error) : "invalid IPC response");
        }
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

  // Runtime owns the plan acquire/poll/apply loop; we only pass it the transport we built above.
  runtime.start(app, { runtimeLog, pluginLog, request });

  // Load the original app (transparent injection).
  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    require(path.join(originalAsar, pkg.main || "index.js"));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e), "error");
  }
};

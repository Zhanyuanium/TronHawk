// TronHawk injector bootstrap — runs in the target's MAIN process.
// Loaded via `require(MODLOADER_MOD_ENTRYPOINT)(originalAsar)` from the remapped app.asar.
//
// Injector responsibility (docs/AGENTS.md): enter process, establish comms with Core,
// and load the trusted Runtime. NO plugin logic lives here — and the Runtime owns the
// plan polling/application loop. This file only builds the IPC transport (connect, frame,
// send, and DUR-1 launch-session renewal) plus the bounded log delivery queue, then hands
// the transport to the Runtime.
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

// --- DUR-1 session renewal ---
//
// Core launch tokens are self-contained HMAC-signed strings (no in-memory session table), so a
// Core restart alone never invalidates a token younger than 600s. A running target still loses
// authorization once a token is older than 600s — and nothing bumps that age automatically — so
// the transport renews the token: (a) proactively before the window closes, and (b) passively
// after an `-32001` unauthorized response (Core restart raced against a stale send, suspend, or
// clock skew). `renewSession` is unauthenticated beyond the current token and returns a fresh
// token while the presented token is <24h old; older tokens can no longer renew.
const SESSION_RENEW_BEFORE_MS = 540000; // renew at 540s, 60s under Core's 600s idle cap
const SESSION_RENEW_RETRY_MS = 30000; // min spacing between renewal attempts after failures
const SESSION_RENEW_TIMEOUT_MS = 5000;
const UNAUTHORIZED_CODE = -32001;

// Module-level serialization: the Runtime's plan poll and the log delivery queue both drive this
// transport concurrently, and renewal swaps the shared `currentSecret`. Every renewal drains
// through this one promise chain so concurrent requesters can never read/write the secret in a
// racy interleaving.
let renewalChain = Promise.resolve();
function enqueueRenewal(run) {
  const task = renewalChain.then(run, run);
  // Keep the chain alive regardless of a task outcome; a failed renewal never poisons later tasks.
  renewalChain = task.then(() => undefined, () => undefined);
  return task;
}

// Transport seam handed to the Runtime. `request(method, params, { timeout })` resolves to
// `{ id, envelope }` so the Runtime can validate `envelope.id` against the id that was sent.
// The Runtime's poll/apply/log loop is unchanged; session renewal happens entirely inside this
// transport. `options.warn` (optional) is where renewal failures are surfaced once; the bootstrap
// routes it through its runtime log stream.
function buildTransport(port, secret, options = {}) {
  const warn =
    typeof options.warn === "function"
      ? options.warn
      : (message) => console.warn("[tronhawk] " + message);
  let nextId = 1;

  // Mutable session state, closure-only. `currentSecret` is the launch token sent with every
  // request; `secretIssuedAt` is when we adopted it (local clock), driving the proactive renew.
  // NOTE: the renewed token deliberately stays in this closure — we never write it back to
  // process.env.TRONHAWK_IPC_SECRET, because that variable is inherited by the target's child
  // processes. Children keep the ORIGINAL token, which now dies at Core's 24h absolute cap.
  let currentSecret = secret;
  let secretIssuedAt = Date.now();
  // After a failed renewal, wait this long before trying again so a dead Core or rotated launch
  // key does not make the poll loop hammer renewSession every 2s.
  let renewalRetryAt = 0;
  let renewalWarned = false;

  const renewalAllowed = () => Date.now() >= renewalRetryAt;
  const renewalDue = () =>
    renewalAllowed() && Date.now() - secretIssuedAt > SESSION_RENEW_BEFORE_MS;

  // One physical request with a fresh id and the current secret.
  const attempt = (method, params, timeout) => {
    const id = nextId++;
    return sendIpc(port, currentSecret, id, method, params, timeout).then((envelope) => ({
      id,
      envelope,
    }));
  };

  const noteRenewalFailure = (reason) => {
    renewalRetryAt = Date.now() + SESSION_RENEW_RETRY_MS;
    if (!renewalWarned) {
      renewalWarned = true;
      warn("launch session renewal failed (" + reason + "); will keep retrying");
    }
    return false;
  };

  // One serialized renewal round-trip. Resolves true only when a fresh token was adopted.
  // Sends renewSession directly (never routed back through `request`), so a -32001 here can
  // never recurse into another renewal.
  const renewWithCurrentSecret = () => {
    const renewId = nextId++;
    return sendIpc(port, currentSecret, renewId, "renewSession", {}, SESSION_RENEW_TIMEOUT_MS)
      .then((envelope) => {
        if (
          !envelope ||
          typeof envelope !== "object" ||
          envelope.version !== "0.1" ||
          envelope.id !== renewId ||
          envelope.error
        ) {
          return noteRenewalFailure(
            envelope && envelope.error && envelope.error.message
              ? envelope.error.message
              : "invalid renewSession response",
          );
        }
        const token =
          envelope.result && typeof envelope.result === "object" ? envelope.result.token : null;
        if (typeof token !== "string" || token.length === 0) {
          return noteRenewalFailure("renewSession returned no token");
        }
        currentSecret = token;
        secretIssuedAt = Date.now();
        renewalWarned = false;
        renewalRetryAt = 0;
        return true;
      })
      .catch((e) => noteRenewalFailure(e && e.message ? e.message : String(e)));
  };

  // Serialized "ensure we hold a usable token". Renews when due (proactive) or when forced
  // (passive -32001 recovery). Queued callers re-check inside the chain, so concurrent requests
  // stay strictly serialized while sharing at most one effective renewal.
  const ensureFreshSecret = (force) =>
    enqueueRenewal(() => {
      if (!force && !renewalDue()) return Promise.resolve(true);
      if (!renewalAllowed()) return Promise.resolve(false); // still backing off a failed renewal
      return renewWithCurrentSecret();
    });

  const request = (method, params, requestOptions = {}) => {
    const timeout = requestOptions && requestOptions.timeout ? requestOptions.timeout : 5000;
    // 1) Proactive renewal: refresh before sending whenever the token approaches the 600s cap.
    return ensureFreshSecret(false)
      .then(() => attempt(method, params, timeout))
      .then((outcome) => {
        const envelope = outcome.envelope;
        if (envelope && envelope.error && envelope.error.code === UNAUTHORIZED_CODE) {
          // 2) Passive recovery: the token was rejected (idle window lapsed, suspend/resume, or a
          // Core restart landed between requests). Renew once, then retry the ORIGINAL request
          // exactly ONCE. -32001 is returned before any side effect, so retrying a log append
          // cannot double-append. All other errors are left to the caller's retry/backoff.
          return ensureFreshSecret(true).then((renewed) => {
            if (!renewed) return outcome; // renewal failed; surface the original -32001
            return attempt(method, params, timeout);
          });
        }
        return outcome;
      });
  };

  return { request };
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

  // Build the transport after the log sinks exist so renewal-failure warnings (DUR-1) can ride
  // the runtime log stream. `request` is only invoked asynchronously (log delivery / runtime
  // poll), so defining it here is safe.
  const { request } = buildTransport(port, secret, {
    warn: (message) => log(message, "warn"),
  });
  log("injected; electron=" + process.versions.electron);

  const { app } = require("electron");
  const runtime = require(path.join(__dirname, "runtime.js"));

  // Runtime owns the plan acquire/poll/apply loop; we only pass it the transport we built above.
  runtime.start(app, { runtimeLog, pluginLog, request });

  // Load the original app (transparent injection).
  //
  // realpathSync workaround (ADR 0001 / ADR 0005): under an MSIX/WindowsApps reparse point,
  // fs.realpathSync resolves the synthetic `_app.asar` alias to a physical path the asar-remap
  // hooks can't substring-match, ENOENT-ing before the original app loads. Return the logical
  // `_app.asar` path unchanged so the hooked lstat/CreateFileW remap it to the real app.asar.
  const NodeFs = require("fs");
  const realpathSyncOrig = NodeFs.realpathSync;
  const realpathNativeOrig = NodeFs.realpathSync.native || realpathSyncOrig;
  const keepLogicalRealpath = function (p) {
    const sp = typeof p === "string" ? p : String(p);
    if (sp.includes("_app.asar")) return sp;
    return realpathNativeOrig.call(this, p);
  };
  NodeFs.realpathSync = keepLogicalRealpath;
  NodeFs.realpathSync.native = keepLogicalRealpath;

  try {
    const pkg = require(path.join(originalAsar, "package.json"));
    require(path.join(originalAsar, pkg.main || "index.js"));
    log("original app loaded");
  } catch (e) {
    log("FAILED to load original app: " + (e && e.stack ? e.stack : e), "error");
  }
};

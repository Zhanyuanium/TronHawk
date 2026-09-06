// TronHawk plugin module/lifecycle contract harness (Phase 2).
//
// The single canonical implementation of the host's CommonJS loading convention,
// extracted for reuse by every runner that must judge a plugin artifact WITHOUT
// inventing a second loading semantics (notably `tronhawk test --sandbox` in
// tools/tronhawk-cli — the CLI calls this module, it never reimplements it).
//
// Host convention mirrored here (see src/index.js):
// - module scaffolding: fresh `module = { exports: {} }` + `exports` globals,
//   then `vm.evalCode(source)` (classic script, NOT a module record).
// - hook lookup: `module.exports.activate` / `module.exports.deactivate` (read from
//   `module.exports`, never the stale `global.exports`) — cf. runMainPlugin /
//   runRendererPlugin ("Call module.exports.activate(ctx) if present").
// - invocation: `vm.callFunction(fn, exportsHandle, ctxHandle)` (this ===
//   module.exports, single ctx argument).
// - lifecycle contract: hooks return `undefined` (synchronous-void); a returned
//   Promise/thenable is drained to settlement instead (ADR 0008, runLifecycleHook).
//   The resolved value of a fulfilled promise is IGNORED (host parity: the
//   host's watchAsyncActivate/drainThenableResult never inspect it — only a
//   synchronous non-undefined value fails the void contract). Throw, rejection,
//   CPU-deadline overrun, or settlement timeout fails.
// - permission-gated ctx: `logger` always; `script`/`dom`/`css`/`storage` only with
//   their renderer grants; `window` only with `electron.window`; `network` ALWAYS
//   present (granted impl, else the denied stub rejecting with
//   NETWORK_ACCESS_DENIED — the exact string in index.js buildNetworkDeniedApi).
// - enforcement: fresh per-operation CPU deadline (QUICKJS_CPU_DEADLINE_MS), 64 MiB
//   memory + 512 KiB stack limits, Promise drain via deadline-wrapped
//   executePendingJobs slices (production parity with drainPendingJobs in
//   src/index.js) bounded by the wall-clock settlement cap, so neither a stuck
//   single job nor an infinite continuation loop can hang the harness.
// - authoring-rule DELTA (intentional, stricter than host): the harness requires
//   BOTH `activate` and `deactivate` exports; the production host
//   (runMainPlugin/runRendererPlugin + capturePluginDeactivate) tolerates a
//   missing hook and only calls what exists. This extra rule is an authoring
//   gate (fail fast on an incomplete lifecycle), NOT host-identical — never
//   claim otherwise. Shape failures are tagged `[authoring rule]` for audit.
//
// What this harness deliberately does NOT do: manifest schema validation, ZIP
// hardening, protocol gating (all authoritative in crates/package Rust), and the
// renderer gate (`entry.renderer` requires `renderer.script` — a pack-time rule
// enforced by Rust and surfaced early by the CLI smoke check).

const {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} = require("quickjs-emscripten-core");
const variantModule = require("@jitl/quickjs-singlefile-cjs-release-sync");
const RELEASE_SYNC = variantModule.default || variantModule;

// --- Parity constants (must match src/index.js) ---
const QUICKJS_CPU_DEADLINE_MS = 1000;
const QUICKJS_MEMORY_LIMIT = 64 * 1024 * 1024;
const QUICKJS_MAX_STACK_SIZE = 1024 * 512;
const MAX_JOBS_PER_SLICE = 1000;
// Wall-clock cap for draining a thenable hook result (mirrors DEACTIVATE_DRAIN_MS:
// async cleanup gets a bounded chance; a never-settling promise never blocks).
const SETTLE_DRAIN_MS = 2000;

// Denied-stub rejection string. MUST stay identical to NETWORK_ACCESS_DENIED in
// src/index.js (buildNetworkDeniedApi) — guests match on this text.
const NETWORK_ACCESS_DENIED = "network.access not granted";

// Globals that must never exist inside the sandbox (Node/Electron/page surface).
// `module`/`exports`/`ctx` are the intentional scaffolding and are NOT listed.
const BANNED_GLOBALS = [
  "process",
  "require",
  "console",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "document",
  "window",
  "electron",
  "Buffer",
  "fetch",
  "XMLHttpRequest",
  "global",
];

const CONTRACT_VERSION = 1;

let QuickJSPromise = null;
function getQuickJS() {
  if (!QuickJSPromise) {
    QuickJSPromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  }
  return QuickJSPromise;
}

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// --- Static contract (pure text scans; no execution) ---
//
// Mirrors the CLI build gates (single-file CJS: no ESM residue, no require
// leftovers) so `test --sandbox` reports the same authoring-contract failures
// the pack pipeline would. A bundled artifact that still contains ESM or
// require() can never satisfy the host convention (`export default` is never
// read by the host; `require` does not exist in QuickJS).

function checkStaticContract(source) {
  const issues = [];
  if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) {
    issues.push("entry retains an ESM `import` (bundle must be single-file CJS)");
  }
  if (
    /^\s*export\s/m.test(source) ||
    /\bexport\s+default\b/.test(source) ||
    /exports\s*\.\s*default\b/.test(source) ||
    /exports\s*\[\s*["']default["']\s*\]/.test(source)
  ) {
    issues.push(
      "entry exposes ESM `export` / `exports.default` (the host reads `module.exports.activate` / `deactivate`)",
    );
  }
  if (/\brequire\s*\(/.test(source)) {
    issues.push("entry contains a residual `require(` (the bundle must be single-file with no require leftovers)");
  }
  return issues;
}

// --- Guest value helpers (mirror handlesFromJson / guestErrorText) ---

function toGuestValue(vm, value) {
  if (value === null || value === undefined) return vm.null;
  const kind = typeof value;
  if (kind === "string") return vm.newString(value);
  if (kind === "number") return vm.newNumber(value);
  if (kind === "boolean") return value ? vm.true : vm.false;
  if (Array.isArray(value)) {
    const arr = vm.newArray();
    let index = 0;
    for (const item of value) {
      const h = toGuestValue(vm, item);
      vm.setProp(arr, index, h);
      h.dispose();
      index += 1;
    }
    return arr;
  }
  if (kind === "object") {
    const obj = vm.newObject();
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const h = toGuestValue(vm, item);
      vm.setProp(obj, key, h);
      h.dispose();
    }
    return obj;
  }
  return vm.undefined;
}

function guestErrorText(vm, errorHandle) {
  try {
    const messageHandle = vm.getProp(errorHandle, "message");
    try {
      if (vm.typeof(messageHandle) === "string") return vm.getString(messageHandle);
    } finally {
      messageHandle.dispose();
    }
  } catch (_e) {
    // Fall through to the dump.
  }
  try {
    const dumped = vm.dump(errorHandle);
    if (typeof dumped === "string") return dumped;
    return JSON.stringify(dumped);
  } catch (_e) {
    return String(errorHandle);
  }
}

// True when a QuickJS value has a callable `then` (borrowed handle, undisposed).
function isThenableResult(vm, valueHandle) {
  const valueType = vm.typeof(valueHandle);
  if (valueType !== "object" && valueType !== "function") return false;
  const thenHandle = vm.getProp(valueHandle, "then");
  try {
    return vm.typeof(thenHandle) === "function";
  } finally {
    thenHandle.dispose();
  }
}

// Run `fn` under a fresh per-operation CPU deadline. Returns { ok, fired } where
// `fired` means the deadline elapsed mid-operation (fail closed even on a
// normal-looking return — mirrors runQuickJSOperation's overrun rule).
function withDeadline(vm, fn) {
  let fired = false;
  const pastDeadline = shouldInterruptAfterDeadline(Date.now() + QUICKJS_CPU_DEADLINE_MS);
  vm.runtime.setInterruptHandler(() => {
    if (!pastDeadline()) return 0;
    fired = true;
    return 1;
  });
  try {
    return { result: fn(), fired };
  } finally {
    try {
      vm.runtime.removeInterruptHandler();
    } catch (_e) {
      // Best effort.
    }
  }
}

// Drain pending promise jobs until none remain, with production deadline
// semantics (cf. drainPendingJobs in src/index.js — read-only reference):
// every executePendingJobs slice runs under a fresh per-operation CPU deadline,
// and the whole drain respects the caller's wall-clock `deadline` so `timeoutMs`
// interrupts BOTH a stuck single job and an infinite continuation loop.
// Returns false when a job threw, the CPU deadline fired mid-slice, or the
// wall-clock cap elapsed (reason captured) — the caller fails closed instead
// of spinning or hanging.
function drainJobs(vm, onJobError, opts = {}) {
  const { deadline = Infinity, label = "async settlement" } = opts;
  while (vm.runtime.hasPendingJob()) {
    if (Date.now() >= deadline) {
      onJobError(
        `${label} timed out waiting for async settlement (wall-clock cap exceeded); treating as failure`,
      );
      return false;
    }
    let guarded;
    try {
      guarded = withDeadline(vm, () => vm.runtime.executePendingJobs(MAX_JOBS_PER_SLICE));
    } catch (e) {
      onJobError(e && e.message ? e.message : String(e));
      return false;
    }
    if (guarded.fired) {
      onJobError(
        `${label} exceeded its CPU deadline (${QUICKJS_CPU_DEADLINE_MS}ms) and did not unwind; treating as failure`,
      );
      return false;
    }
    const slice = guarded.result;
    try {
      if (slice && slice.error) {
        onJobError(guestErrorText(vm, slice.error));
        return false;
      }
    } finally {
      if (slice && typeof slice.dispose === "function") {
        try {
          slice.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
    }
  }
  return true;
}

// Pump a guest promise handle to settlement (bounded). Returns
// { status: "fulfilled" | "rejected" | "timeout" | "error", reason? }.
// Does NOT dispose `promiseHandle` (caller-owned); disposes state handles.
// The fulfillment VALUE is intentionally ignored (host parity — see above).
function pumpUntilSettled(vm, promiseHandle, timeoutMs, pumpIssues, label = "async settlement") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      !drainJobs(
        vm,
        (reason) => {
          pumpIssues.push(reason);
        },
        { deadline, label },
      )
    ) {
      return { status: "error", reason: pumpIssues[pumpIssues.length - 1] || "pump failed" };
    }
    let state;
    try {
      state = vm.getPromiseState(promiseHandle);
    } catch (_e) {
      return { status: "error", reason: "VM is going away" };
    }
    if (state.type === "fulfilled") {
      if (!state.notAPromise && state.value) {
        try {
          state.value.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      return { status: "fulfilled" };
    }
    if (state.type === "rejected") {
      let reason = "rejected";
      if (state.error) {
        try {
          reason = guestErrorText(vm, state.error);
        } finally {
          try {
            state.error.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
      }
      return { status: "rejected", reason };
    }
    if (Date.now() >= deadline) return { status: "timeout" };
  }
}

// Build the permission-gated ctx for one VM. `calls` records stub invocations,
// `logs` captures ctx.logger output as [level, message]. Deferreds that outlive
// their host call are registered in `ownedDeferreds` for post-drain disposal.
function buildCtx(vm, { pluginId, permissions, kind, logs, calls, ownedDeferreds, teardowns }) {
  const ctx = vm.newObject();
  const logger = vm.newObject();
  for (const level of ["info", "warn", "error"]) {
    const method = vm.newFunction(level, (messageHandle) => {
      if (vm.typeof(messageHandle) === "string") {
        logs.push([level, vm.getString(messageHandle)]);
      }
      return vm.undefined;
    });
    vm.setProp(logger, level, method);
    method.dispose();
  }
  vm.setProp(ctx, "logger", logger);
  logger.dispose();

  // Settle a host stub result synchronously (canned sandbox data): resolve or
  // reject immediately, keep the deferred alive until post-drain disposal —
  // disposing it early would kill the guest-visible handle (host handle
  // disposal frees the host reference; the guest keeps its own).
  function settledResult(mode, makeValue) {
    const deferred = vm.newPromise();
    const handle = deferred.handle;
    const value = makeValue();
    try {
      if (mode === "reject") deferred.reject(value);
      else deferred.resolve(value);
    } finally {
      if (value && typeof value.dispose === "function") {
        try {
          value.dispose();
        } catch (_e) {
          // Best effort — settlement already happened.
        }
      }
    }
    ownedDeferreds.push(deferred);
    return handle;
  }

  if (kind === "renderer" && hasPermission(permissions, "renderer.script")) {
    const script = vm.newObject();
    const setDocumentTitle = vm.newFunction("setDocumentTitle", (titleHandle) => {
      const title = vm.typeof(titleHandle) === "string" ? vm.getString(titleHandle) : "";
      calls.setDocumentTitle.push(title);
      return vm.undefined;
    });
    vm.setProp(script, "setDocumentTitle", setDocumentTitle);
    setDocumentTitle.dispose();
    vm.setProp(ctx, "script", script);
    script.dispose();
  }
  if (kind === "renderer" && hasPermission(permissions, "renderer.dom")) {
    const dom = vm.newObject();
    const query = vm.newFunction("query", () =>
      settledResult("resolve", () => vm.null),
    );
    vm.setProp(dom, "query", query);
    query.dispose();
    // Host parity (buildDomApi in src/index.js): `observe` returns a callable
    // `disconnect` that stops delivery. The harness has no page to poll, so no
    // callbacks ever fire here — but the registry/disconnect semantics are real:
    // re-observing a selector replaces the prior entry (old callback disposed),
    // disconnect marks the entry stopped + disposes its dup'd callback, and VM
    // teardown disposes anything still connected. Disconnect is idempotent.
    const domObserverEntries = [];
    const domObserverBySelector = new Map();
    const observe = vm.newFunction("observe", (selectorHandle, cbHandle) => {
      if (vm.typeof(selectorHandle) !== "string" || vm.typeof(cbHandle) !== "function") {
        return vm.undefined;
      }
      const selector = vm.getString(selectorHandle);
      const prior = domObserverBySelector.get(selector);
      if (prior && !prior.disconnected) {
        prior.disconnected = true;
        try {
          prior.callback.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      calls.domObserve.push(selector);
      const callback = cbHandle.dup();
      const entry = { selector, callback, disconnected: false };
      domObserverEntries.push(entry);
      domObserverBySelector.set(selector, entry);
      const disconnect = vm.newFunction("disconnect", () => {
        if (!entry.disconnected) {
          entry.disconnected = true;
          if (domObserverBySelector.get(selector) === entry) {
            domObserverBySelector.delete(selector);
          }
          calls.domDisconnect.push(selector);
          try {
            callback.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
        return vm.undefined;
      });
      return disconnect;
    });
    vm.setProp(dom, "observe", observe);
    observe.dispose();
    vm.setProp(ctx, "dom", dom);
    dom.dispose();
    if (Array.isArray(teardowns)) {
      teardowns.push(() => {
        for (const entry of domObserverEntries) {
          if (!entry.disconnected) {
            entry.disconnected = true;
            try {
              entry.callback.dispose();
            } catch (_e) {
              // Best effort.
            }
          }
        }
        domObserverBySelector.clear();
      });
    }
  }
  // No-op read-only config view (sandbox carries no Core plan snapshot).
  const config = vm.newObject();
  const configGet = vm.newFunction("get", () => vm.undefined);
  vm.setProp(config, "get", configGet);
  configGet.dispose();
  const configSet = vm.newFunction("set", () => vm.undefined);
  vm.setProp(config, "set", configSet);
  configSet.dispose();
  vm.setProp(ctx, "config", config);
  config.dispose();

  // `network` is ALWAYS present (SDK PluginContext surface): the granted impl
  // resolves a canned response; otherwise the denied stub rejects with the
  // catchable NETWORK_ACCESS_DENIED string (host parity).
  const network = vm.newObject();
  if (hasPermission(permissions, "network.access")) {
    const request = vm.newFunction("request", (reqHandle) => {
      let url = "";
      if (vm.typeof(reqHandle) === "object") {
        const urlHandle = vm.getProp(reqHandle, "url");
        if (vm.typeof(urlHandle) === "string") url = vm.getString(urlHandle);
        urlHandle.dispose();
      }
      calls.networkRequest.push({ url });
      return settledResult("resolve", () =>
        toGuestValue(vm, { status: 200, body: "", headers: {} }),
      );
    });
    vm.setProp(network, "request", request);
    request.dispose();
  } else {
    const request = vm.newFunction("request", () =>
      settledResult("reject", () => vm.newString(NETWORK_ACCESS_DENIED)),
    );
    vm.setProp(network, "request", request);
    request.dispose();
  }
  vm.setProp(ctx, "network", network);
  network.dispose();

  if (kind === "renderer" && hasPermission(permissions, "renderer.css")) {
    const css = vm.newObject();
    const insert = vm.newFunction("insert", (cssHandle) => {
      const text = vm.typeof(cssHandle) === "string" ? vm.getString(cssHandle) : "";
      const key = "sandbox-css-" + (calls.cssInsert.length + 1);
      calls.cssInsert.push(text);
      return settledResult("resolve", () => vm.newString(key));
    });
    vm.setProp(css, "insert", insert);
    insert.dispose();
    const remove = vm.newFunction("remove", () => settledResult("resolve", () => vm.undefined));
    vm.setProp(css, "remove", remove);
    remove.dispose();
    vm.setProp(ctx, "css", css);
    css.dispose();
  }
  if (kind === "renderer" && hasPermission(permissions, "renderer.storage")) {
    const store = new Map();
    const storage = vm.newObject();
    const get = vm.newFunction("get", (keyHandle) => {
      const key = vm.typeof(keyHandle) === "string" ? vm.getString(keyHandle) : "";
      const value = store.has(key) ? store.get(key) : null;
      return settledResult("resolve", () => toGuestValue(vm, value));
    });
    vm.setProp(storage, "get", get);
    get.dispose();
    const set = vm.newFunction("set", (keyHandle, valueHandle) => {
      const key = vm.typeof(keyHandle) === "string" ? vm.getString(keyHandle) : "";
      try {
        store.set(key, vm.dump(valueHandle));
      } catch (_e) {
        store.set(key, null);
      }
      return settledResult("resolve", () => vm.undefined);
    });
    vm.setProp(storage, "set", set);
    set.dispose();
    vm.setProp(ctx, "storage", storage);
    storage.dispose();
  }
  if (kind === "main" && hasPermission(permissions, "electron.window")) {
    const win = vm.newObject();
    const onCreated = vm.newFunction("onCreated", (cbHandle) => {
      if (vm.typeof(cbHandle) === "function") calls.windowOnCreated.push(true);
      return vm.undefined;
    });
    vm.setProp(win, "onCreated", onCreated);
    onCreated.dispose();
    // Implemented host surface (buildWindowApi in src/index.js): sync-void
    // setters. The harness records calls and returns undefined so legal
    // plugins pass. (ctx.webContents.* stays unmounted: Future per
    // docs/PLUGIN-SDK.md — the host has no such surface either.)
    //
    // [authoring rule — unified WindowHandle] The host issues BrowserWindow.id
    // from all three lifecycle events when a live window is bound (onCreated
    // already did; onRendererReady/onUnload now match — see issuedWindowHandle
    // in src/index.js). Contents-only (no BrowserWindow) still issues
    // webContents.id so rr:/ul: assertions stay numeric. Window ops resolve
    // via fromId then a webContents-id scan on miss; unknown ids stay
    // structured no-ops. Cross-namespace same-value collision (A {id:100,
    // webContents.id:1} vs B {id:1, webContents.id:2}) is avoided by unified
    // issuance, not by dual-space guesswork — Electron's two counters are
    // independent and do collide. The harness has no live windows to resolve
    // against, so it records the numeric id verbatim — a guest passing a
    // lifecycle-received id into an op records it unchanged here and reaches
    // its window in the host. Proven end-to-end host-side by the "unified
    // WindowHandle" / collision tests in platform.test.js.
    const setOpacity = vm.newFunction("setOpacity", (winHandle, nHandle) => {
      try {
        calls.windowSetOpacity.push({
          window: vm.getNumber(winHandle),
          opacity: vm.getNumber(nHandle),
        });
      } catch (_e) {
        calls.windowSetOpacity.push({ window: 0, opacity: 0 });
      }
      return vm.undefined;
    });
    vm.setProp(win, "setOpacity", setOpacity);
    setOpacity.dispose();
    const setSize = vm.newFunction("setSize", (winHandle, wHandle, hHandle) => {
      try {
        calls.windowSetSize.push({
          window: vm.getNumber(winHandle),
          width: vm.getNumber(wHandle),
          height: vm.getNumber(hHandle),
        });
      } catch (_e) {
        calls.windowSetSize.push({ window: 0, width: 0, height: 0 });
      }
      return vm.undefined;
    });
    vm.setProp(win, "setSize", setSize);
    setSize.dispose();
    const setPosition = vm.newFunction("setPosition", (winHandle, xHandle, yHandle) => {
      try {
        calls.windowSetPosition.push({
          window: vm.getNumber(winHandle),
          x: vm.getNumber(xHandle),
          y: vm.getNumber(yHandle),
        });
      } catch (_e) {
        calls.windowSetPosition.push({ window: 0, x: 0, y: 0 });
      }
      return vm.undefined;
    });
    vm.setProp(win, "setPosition", setPosition);
    setPosition.dispose();
    const setVibrancy = vm.newFunction("setVibrancy", (winHandle, materialHandle) => {
      try {
        calls.windowSetVibrancy.push({
          window: vm.getNumber(winHandle),
          material: vm.typeof(materialHandle) === "string" ? vm.getString(materialHandle) : "",
        });
      } catch (_e) {
        calls.windowSetVibrancy.push({ window: 0, material: "" });
      }
      return vm.undefined;
    });
    vm.setProp(win, "setVibrancy", setVibrancy);
    setVibrancy.dispose();
    const setMica = vm.newFunction("setMica", (winHandle, enabledHandle) => {
      try {
        let enabled = false;
        if (vm.typeof(enabledHandle) === "boolean") enabled = !!vm.dump(enabledHandle);
        else enabled = vm.getNumber(enabledHandle) !== 0;
        calls.windowSetMica.push({ window: vm.getNumber(winHandle), enabled });
      } catch (_e) {
        calls.windowSetMica.push({ window: 0, enabled: false });
      }
      return vm.undefined;
    });
    vm.setProp(win, "setMica", setMica);
    setMica.dispose();
    vm.setProp(ctx, "window", win);
    win.dispose();
  }
  // Main lifecycle events (attachLifecycleApi parity in src/index.js): mounted
  // at the main ctx ROOT, always present on main kind (the host gates nothing
  // here — subscriptions exist even without further grants). Registration is
  // sync-void; the harness records subscriptions so legal plugins pass instead
  // of failing on a missing function.
  if (kind === "main") {
    const onLoad = vm.newFunction("onLoad", (cbHandle) => {
      if (vm.typeof(cbHandle) === "function") calls.lifecycleSubscribe.push({ event: "onLoad" });
      return vm.undefined;
    });
    vm.setProp(ctx, "onLoad", onLoad);
    onLoad.dispose();
    const onRendererReady = vm.newFunction("onRendererReady", (cbHandle) => {
      if (vm.typeof(cbHandle) === "function")
        calls.lifecycleSubscribe.push({ event: "onRendererReady" });
      return vm.undefined;
    });
    vm.setProp(ctx, "onRendererReady", onRendererReady);
    onRendererReady.dispose();
    const onUnload = vm.newFunction("onUnload", (cbHandle) => {
      if (vm.typeof(cbHandle) === "function") calls.lifecycleSubscribe.push({ event: "onUnload" });
      return vm.undefined;
    });
    vm.setProp(ctx, "onUnload", onUnload);
    onUnload.dispose();
  }
  return ctx;
}

function emptyCalls() {
  return {
    setDocumentTitle: [],
    networkRequest: [],
    cssInsert: [],
    domObserve: [],
    domDisconnect: [],
    windowOnCreated: [],
    windowSetOpacity: [],
    windowSetSize: [],
    windowSetPosition: [],
    windowSetVibrancy: [],
    windowSetMica: [],
    lifecycleSubscribe: [],
  };
}

// Run one lifecycle hook (activate/deactivate) with the host contract:
// sync-undefined ok; thenable drained to settlement; anything else fails.
// Appends issues; returns { ran, wasAsync }.
function runHook(vm, { pluginId, label, kind, invoke, timeoutMs, issues }) {
  let ran = false;
  let wasAsync = false;
  const guarded = withDeadline(vm, invoke);
  if (guarded.fired) {
    issues.push(`${label} exceeded its CPU deadline (${QUICKJS_CPU_DEADLINE_MS}ms) and did not unwind; treating as failure`);
    return { ran, wasAsync };
  }
  const result = guarded.result;
  if (!result) {
    issues.push(`${label} failed: host invocation threw`);
    return { ran, wasAsync };
  }
  if (result.error) {
    let reason;
    try {
      reason = guestErrorText(vm, result.error);
    } finally {
      try {
        result.error.dispose();
      } catch (_e) {
        // Best effort.
      }
    }
    issues.push(`${label} failed: ${reason}`);
    return { ran, wasAsync };
  }
  ran = true;
  if (isThenableResult(vm, result.value)) {
    wasAsync = true;
    const outcome = pumpUntilSettled(vm, result.value, timeoutMs, issues, `${label} async settlement`);
    try {
      result.value.dispose();
    } catch (_e) {
      // Best effort.
    }
    if (outcome.status === "rejected") {
      issues.push(`${label} rejected: ${outcome.reason}`);
    } else if (outcome.status === "timeout") {
      issues.push(
        `${label} timed out waiting for async settlement (>${timeoutMs}ms); treating as failure`,
      );
    } else if (outcome.status === "error") {
      issues.push(`${label} pump failed: ${outcome.reason}`);
    }
  } else if (vm.typeof(result.value) !== "undefined") {
    const resultType = vm.typeof(result.value);
    try {
      result.value.dispose();
    } catch (_e) {
      // Best effort.
    }
    issues.push(
      `${label} rejected asynchronous/non-void lifecycle result (expected undefined, got ${resultType})`,
    );
    return { ran: false, wasAsync };
  } else {
    try {
      result.value.dispose();
    } catch (_e) {
      // Best effort.
    }
  }
  return { ran, wasAsync };
}

/**
 * Run the full module/lifecycle contract check for one entry source.
 *
 * @param {object} opts
 * @param {string} opts.source entry source text (the built artifact bytes).
 * @param {string[]} [opts.permissions] declared manifest permissions (grant set).
 * @param {"renderer"|"main"} [opts.kind] ctx surface to mount.
 * @param {string} [opts.filename] eval filename for error messages.
 * @param {number} [opts.timeoutMs] async-settlement cap per hook.
 * @returns {Promise<{ok:boolean, issues:string[], logs:Array<[string,string]>,
 *   calls:object, async:{activateWasAsync:boolean, deactivateWasAsync:boolean}}>}
 */
async function runContractCheck({
  source,
  permissions = [],
  kind = "renderer",
  filename = "entry.js",
  timeoutMs = SETTLE_DRAIN_MS,
}) {
  const logs = [];
  const calls = emptyCalls();
  const asyncFlags = { activateWasAsync: false, deactivateWasAsync: false };
  const staticIssues = checkStaticContract(source).map((m) => `static: ${m}`);
  if (staticIssues.length > 0) {
    // Fail fast like the pack pipeline: an artifact that is not single-file CJS
    // can never satisfy the host convention (the host would misload or throw).
    return { ok: false, issues: staticIssues, logs, calls, async: asyncFlags };
  }

  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(QUICKJS_MEMORY_LIMIT);
  vm.runtime.setMaxStackSize(QUICKJS_MAX_STACK_SIZE);
  const ownedDeferreds = [];
  const teardowns = [];
  const issues = [];
  const disposeOwned = () => {
    for (const d of ownedDeferreds) {
      try {
        if (d.handle && d.handle.alive) d.handle.dispose();
      } catch (_e) {
        // Best effort.
      }
      try {
        d.dispose();
      } catch (_e) {
        // Best effort.
      }
    }
    ownedDeferreds.length = 0;
  };

  try {
    const ctx = buildCtx(vm, {
      pluginId: "sandbox",
      permissions,
      kind,
      logs,
      calls,
      ownedDeferreds,
      teardowns,
    });
    vm.setProp(vm.global, "ctx", ctx);
    ctx.dispose();

    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    vm.setProp(vm.global, "exports", exportsObj);
    moduleObj.dispose();
    exportsObj.dispose();

    const evalGuarded = withDeadline(vm, () => vm.evalCode(source, filename));
    if (evalGuarded.fired) {
      issues.push(`load: eval exceeded its CPU deadline (${QUICKJS_CPU_DEADLINE_MS}ms)`);
      return { ok: false, issues, logs, calls, async: asyncFlags };
    }
    const evalResult = evalGuarded.result;
    if (!evalResult) {
      issues.push("load: eval failed: host invocation threw");
      return { ok: false, issues, logs, calls, async: asyncFlags };
    }
    if (evalResult.error) {
      let reason;
      try {
        reason = guestErrorText(vm, evalResult.error);
      } finally {
        try {
          evalResult.error.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      issues.push(`load: eval failed: ${reason}`);
      return { ok: false, issues, logs, calls, async: asyncFlags };
    }
    try {
      evalResult.value.dispose();
    } catch (_e) {
      // Best effort.
    }

    // Hook lookup reads `module.exports` (never the stale `global.exports`).
    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const deactivate = vm.getProp(exportsHandle, "deactivate");
    const activateType = vm.typeof(activate);
    const deactivateType = vm.typeof(deactivate);
    if (activateType !== "function") {
      issues.push(
        `shape: entry must export \`activate\` as a function via \`module.exports\` (got ${activateType}) [authoring rule — stricter than host: the production host tolerates a missing hook, the harness requires both]`,
      );
    }
    if (deactivateType !== "function") {
      issues.push(
        `shape: entry must export \`deactivate\` as a function via \`module.exports\` (got ${deactivateType}) [authoring rule — stricter than host: the production host tolerates a missing hook, the harness requires both]`,
      );
    }
    if (issues.length > 0) {
      activate.dispose();
      deactivate.dispose();
      exportsHandle.dispose();
      moduleHandle.dispose();
      return { ok: false, issues, logs, calls, async: asyncFlags };
    }

    // Globals probe: the sandbox must expose nothing but the scaffolding.
    const probeHandle = vm.evalCode(
      `JSON.stringify(${JSON.stringify(BANNED_GLOBALS)}.map((k) => [k, typeof globalThis[k]]))`,
      "<sandbox-probe>",
    );
    if (!probeHandle.error) {
      try {
        const pairs = JSON.parse(vm.dump(probeHandle.value));
        for (const [name, type] of pairs) {
          if (type !== "undefined") {
            issues.push(`globals: forbidden global '${name}' is defined (typeof ${type})`);
          }
        }
      } catch (_e) {
        issues.push("globals: probe failed to parse");
      }
      try {
        probeHandle.value.dispose();
      } catch (_e) {
        // Best effort.
      }
    } else {
      try {
        probeHandle.error.dispose();
      } catch (_e) {
        // Best effort.
      }
      issues.push("globals: probe failed to evaluate");
    }

    const ctxHandle = vm.getProp(vm.global, "ctx");
    const actResult = runHook(vm, {
      pluginId: "sandbox",
      label: `${kind} activate`,
      kind,
      invoke: () => vm.callFunction(activate, exportsHandle, ctxHandle),
      timeoutMs,
      issues,
    });
    asyncFlags.activateWasAsync = actResult.wasAsync;
    let deactWasAsync = false;
    if (actResult.ran) {
      // Re-read deactivate after activate (host parity: capturePluginDeactivate
      // runs post-activation against the live module.exports).
      const moduleHandle2 = vm.getProp(vm.global, "module");
      const exportsHandle2 = vm.getProp(moduleHandle2, "exports");
      const deactivate2 = vm.getProp(exportsHandle2, "deactivate");
      const deactResult = runHook(vm, {
        pluginId: "sandbox",
        label: `${kind} deactivate`,
        kind,
        invoke: () => vm.callFunction(deactivate2, exportsHandle2, ctxHandle),
        timeoutMs,
        issues,
      });
      deactWasAsync = deactResult.wasAsync;
      deactivate2.dispose();
      exportsHandle2.dispose();
      moduleHandle2.dispose();
    }
    asyncFlags.deactivateWasAsync = deactWasAsync;
    activate.dispose();
    deactivate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();
  } finally {
    disposeOwned();
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch (_e) {
        // Best effort.
      }
    }
    try {
      vm.dispose();
    } catch (_e) {
      // Best effort.
    }
  }
  return { ok: issues.length === 0, issues, logs, calls, async: asyncFlags };
}

module.exports = {
  CONTRACT_VERSION,
  QUICKJS_CPU_DEADLINE_MS,
  SETTLE_DRAIN_MS,
  NETWORK_ACCESS_DENIED,
  BANNED_GLOBALS,
  checkStaticContract,
  runContractCheck,
  getQuickJS,
};

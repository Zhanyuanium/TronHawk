// TronHawk Runtime (main-process side) — executes the plugin execution plan.
// Provides gated APIs and bridges to Electron (docs/AGENTS.md: Runtime layer).
//
// The Runtime also owns plan acquisition from Core: it polls `getExecutionPlan` over a transport
// handed in by the injector bootstrap (`start(app, { runtimeLog, pluginLog, request })`) and
// applies revision-diffed plans. The bootstrap is transport-only and never owns orchestration.
//
// Phase 2: CSS injection via `webContents.insertCSS` (data, never executed as JS), with a
// multi-plugin, revision-based state machine supporting hot reload, removal, and revocation.
// Phase 3: main-process plugin JS runs in an embedded QuickJS sandbox (no DOM/network/Node),
// reaching Electron only through permission-gated host functions
// (docs/adr/0002-renderer-js-sandbox.md).
const { BrowserWindow } = require("electron");

// Compat adapter (compat profile) loader — see src/adapters.js. Adapters are trusted runtime
// substrate statically bundled into runtime.js (never loaded from disk, never installable), and
// their selection/bootstrap runs synchronously inside start(), BEFORE bootstrap.js requires the
// original target app.
const adapters = require("./adapters");

const MAX_LOG_MESSAGE_BYTES = 1024;
let runtimeLogSink = (level, message) => console.log(`[tronhawk-runtime][${level}] ${message}`);
let pluginLogSink = (pluginId, level, message) =>
  console.log(`[tronhawk-runtime:${pluginId}][${level}] ${message}`);

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

function log(message, level = "info") {
  runtimeLogSink(level, boundedMessage(message));
}

function pluginLog(pluginId, level, message) {
  pluginLogSink(pluginId, level, boundedMessage(message));
}

let currentPlan = { revision: "", plugins: [] };
let planGeneration = 0;
// webContents.id -> { contents, keys: Map(pluginId -> { css, key }), gens: Map(pluginId -> n) }
const windows = new Map();
let appRef = null;
// Adapter selected by the current start(); the did-finish-load handler consults it for the
// optional `renderer.gate(win, ready)` timing seam (Path A). No gate -> default timing.
let activeAdapter = null;

// Platform the runtime executes on. Defaults to the real host platform; the bun harness overrides
// it through the __testing seam (setPlatform) to exercise the macOS/Windows-only host functions on
// any host. In the bundled runtime this is always process.platform.
let hostPlatform = process.platform;

// Window-handle resolution for the window host functions. The real runtime resolves through
// Electron's BrowserWindow.fromId. The bun harness replaces this via __testing because `bun test`
// shares one module registry across files: index.js captures whichever test file's "electron" stub
// required it first, so a later file cannot rely on its own stub identity. The seam keeps the
// feature tests hermetic without changing production behavior.
let windowResolver = (id) => BrowserWindow.fromId(id);

// Main-plugin lifecycle events (SPEC §9 MVP: onLoad / onRendererReady / onUnload). onWindowCreated
// already exists as ctx.window.onCreated. Subscriptions are module-level because their host events
// (app ready, per-window did-finish-load / webContents destroyed) are process-wide, not per-plugin;
// each entry below belongs to exactly one plugin VM and is removed through that plugin's
// cleanupCallbacks array (revoke/deactivate) or when it fails closed.
const loadCallbacks = new Set(); // ctx.onLoad — one-shot per subscription
const rendererReadyCallbacks = new Set(); // ctx.onRendererReady — fires per did-finish-load
const unloadCallbacks = new Set(); // ctx.onUnload — fires per webContents destroyed
// True once the target app's own main process finished loading its original app (app ready).
// ctx.onLoad subscriptions made after this point fire immediately (the event already passed).
let appLoaded = false;

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// --- CSS injection ---

const CSS_REMOVE_MAX_ATTEMPTS = 3;
// Short backoff between removal attempts (indexed attempt-1). Kept tiny: reconcile is per-window
// and per-plan-revision, so at most a handful of removals race at once.
const CSS_REMOVE_BACKOFF_MS = [20, 80];

function errorText(error) {
  return error && error.message ? error.message : error;
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentsDestroyed(w) {
  const contents = w && w.contents;
  return !contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed());
}

// Remove an inserted-CSS key with bounded retries, replacing the old wholesale `.catch(() => {})`
// that silently swallowed failures and left stale CSS applied while the code logged success.
// Resolves true when removal succeeded OR the owning window/contents is already gone (nothing can
// display the stale CSS anymore); resolves false after the final attempt so the caller can mark
// the removal as failed (the reconcile loop then keeps the entry for a later retry).
async function removeCssKey(w, pid, key) {
  const contents = w.contents;
  for (let attempt = 1; attempt <= CSS_REMOVE_MAX_ATTEMPTS; attempt++) {
    try {
      await contents.removeInsertedCSS(key);
      return true;
    } catch (e) {
      if (contentsDestroyed(w)) {
        // Window destroyed mid-removal (Electron rejects with "Object has been destroyed"): there
        // is nothing left to retry and no live window can show the stale CSS. Not an error.
        return true;
      }
      if (attempt === CSS_REMOVE_MAX_ATTEMPTS) {
        pluginLog(
          pid,
          "error",
          "CSS removal failed after " + CSS_REMOVE_MAX_ATTEMPTS + " attempts: " + errorText(e),
        );
        return false;
      }
      await delayMs(CSS_REMOVE_BACKOFF_MS[attempt - 1] || 100);
    }
  }
  return false;
}

function inject(w, pid, css) {
  const gen = (w.gens.get(pid) || 0) + 1;
  w.gens.set(pid, gen);

  const old = w.keys.get(pid);
  w.keys.delete(pid);
  const removeOld = old
    ? removeCssKey(w, pid, old.key)
    : Promise.resolve(true);

  removeOld
    .then((removed) => {
      if (old && !removed) {
        // Old CSS could not be revoked even after retries; still inject the new CSS but surface
        // the stale-sheet risk instead of pretending the revoke succeeded.
        pluginLog(pid, "warn", "CSS supersede removal failed; stale CSS may remain applied");
      }
      return w.contents.insertCSS(css);
    })
    .then((key) => {
      if (w.gens.get(pid) !== gen) {
        // A newer generation superseded this one before insertion completed; remove it.
        removeCssKey(w, pid, key);
        return;
      }
      w.keys.set(pid, { css, key });
      pluginLog(pid, "info", "CSS injected");
    })
    .catch((e) => pluginLog(pid, "error", "CSS injection failed: " + errorText(e)));
}

function reconcile(w) {
  const wanted = new Map();
  for (const p of currentPlan.plugins) {
    if (p.css && hasPermission(p.granted, "renderer.css")) {
      wanted.set(p.id, { css: p.css });
    }
  }

  for (const [pid, want] of wanted) {
    const entry = w.keys.get(pid);
    if (!entry || entry.css !== want.css) {
      inject(w, pid, want.css);
    }
  }

  const allIds = new Set([...w.keys.keys(), ...w.gens.keys()]);
  for (const pid of allIds) {
    if (!wanted.has(pid)) {
      const removalGen = (w.gens.get(pid) || 0) + 1;
      w.gens.set(pid, removalGen);
      const entry = w.keys.get(pid);
      if (entry) {
        w.keys.delete(pid);
        removeCssKey(w, pid, entry.key).then((removed) => {
          if (removed) {
            pluginLog(pid, "info", "CSS removed");
          } else if (
            windows.get(w.contents.id) === w &&
            w.gens.get(pid) === removalGen &&
            !w.keys.has(pid)
          ) {
            // Removal ultimately failed while the window is still alive. Re-register the entry so
            // the next reconcile retries the removal instead of silently dropping the stale CSS.
            w.keys.set(pid, entry);
          }
        });
      }
    }
  }
}

// --- Main-plugin QuickJS sandbox ---

const {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} = require("quickjs-emscripten-core");
const variantModule = require("@jitl/quickjs-singlefile-cjs-release-sync");
const RELEASE_SYNC = variantModule.default || variantModule;

let QuickJSPromise = null;
// Test seam: number of getQuickJS() calls (exposed via __testing). A raw (runtime.unsafe) plugin
// load must never touch the QuickJS module, so this stays 0 across raw-only reconciles.
let quickJSGetCount = 0;
function getQuickJS() {
  quickJSGetCount += 1;
  if (!QuickJSPromise) {
    QuickJSPromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  }
  return QuickJSPromise;
}

// pluginId -> { vm, deactivate }
const mainPlugins = new Map();
// pluginId -> { generation, fingerprint }
const pendingMainPlugins = new Map();
// `${pluginId}@${webContentsId}` -> { vm, deactivate }
const rendererPlugins = new Map();
// `${pluginId}@${webContentsId}` -> { generation, windowGeneration, fingerprint }
const pendingRendererPlugins = new Map();

const QUICKJS_CPU_DEADLINE_MS = 1000;
const quickJSDeadlineStacks = new WeakMap();
// vm -> number of deadline interrupts fired against this VM since it was created. Each firing
// means QuickJS raised the "interrupted" exception because a per-operation CPU budget expired.
const quickJSInterruptCounts = new WeakMap();
// plugin ids hard-disabled for the current plan generation after exceeding the interrupt limit.
const abuseDisabledPlugins = new Set();

// Cumulative-CPU policy (audit RT-1/RT-2). Honest statement of the limits:
//
// 1. Every operation (eval, activate, callback) gets a *fresh* per-operation wall-clock budget of
//    QUICKJS_CPU_DEADLINE_MS of main-thread CPU, so a hostile plugin could otherwise spread
//    unbounded total CPU across many events, each restarting the budget. We do not (and cheaply
//    cannot) meter actual CPU used below one deadline; instead interrupts are counted per VM and
//    the plugin is disabled once QUICKJS_CPU_DEADLINE_INTERRUPT_LIMIT expired deadlines have
//    accumulated. That bounds total CPU to roughly limit * ~1s per loaded VM instance. When the
//    budget expires during a run, the operation is failed (fail closed) even if the guest code
//    returned normally afterwards, so a plugin cannot silently "succeed" after overrunning.
// 2. Enforcement note: deadline enforcement in this QuickJS build can lag past the wall-clock
//    deadline when a plugin is dense in guest->host calls (interrupt checks happen between
//    bytecode, not inside host calls), so a single overrunning operation may burn somewhat more
//    than QUICKJS_CPU_DEADLINE_MS before the interpreter raises "interrupted". Empirical probes
//    on this build show guest `try { ... } catch (e) {}` does NOT intercept the "interrupted"
//    abort, and the operation unwinds to a host-visible failure. The counting below is defensive
//    for the audit-reported shape where a build or nesting path does deliver a catchable
//    "interrupted" (or where repeated callbacks each exhaust a fresh budget): interrupts are
//    recorded per VM and the plugin is hard-killed once the limit is exceeded, instead of only
//    failing the one call.
// 3. A plugin that, on whatever build, absorbs every interrupt inside a single never-returning
//    operation cannot be reclaimed from the same synchronous JS stack in the sync QuickJS variant
//    (disposing the VM from inside its own interrupt callback is unsafe). We still count those
//    firings so the VM is killed the moment control returns; enforcing that residual case would
//    require the asyncify/worker variant or an out-of-process watchdog and is out of scope here.
const QUICKJS_CPU_DEADLINE_INTERRUPT_LIMIT = 3;

function errorMessage(error) {
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch (_e) {
      // Fall through to String for non-serializable errors.
    }
  }
  return String(error);
}

// Wraps the stock deadline handler with per-VM interrupt accounting: every time the deadline has
// passed AND QuickJS asks whether to abort, we record another fired interrupt before answering.
function makeInterruptHandler(vm, deadline) {
  const pastDeadline = shouldInterruptAfterDeadline(deadline);
  return () => {
    if (!pastDeadline()) return 0;
    quickJSInterruptCounts.set(vm, (quickJSInterruptCounts.get(vm) || 0) + 1);
    return 1;
  };
}

function runQuickJSOperation(vm, pluginId, label, operation, requireUndefined = false) {
  if ((quickJSInterruptCounts.get(vm) || 0) > QUICKJS_CPU_DEADLINE_INTERRUPT_LIMIT) {
    // This VM already exhausted its cumulative CPU budget (RT-1/RT-2). Refuse to run any further
    // guest code; the crossing operation scheduled the VM's disposal, and callers treat a `false`
    // return as fail-closed (unregistering the callback or disposing the VM).
    return false;
  }
  const interruptsBefore = quickJSInterruptCounts.get(vm) || 0;
  let result;
  const deadlines = quickJSDeadlineStacks.get(vm) || [];
  // Depth of the already-active operation stack before this one; 0 means this is the outermost
  // operation for the VM, so when it returns no guest frame is running and disposal is safe.
  const outerDepth = deadlines.length;
  const deadline = Date.now() + QUICKJS_CPU_DEADLINE_MS;
  deadlines.push(deadline);
  quickJSDeadlineStacks.set(vm, deadlines);
  vm.runtime.setInterruptHandler(makeInterruptHandler(vm, deadline));
  let ok = true;
  try {
    result = operation();
  } catch (e) {
    pluginLog(pluginId, "error", label + " failed: " + (e && e.message ? e.message : e));
    ok = false;
  } finally {
    vm.runtime.removeInterruptHandler();
    deadlines.pop();
    const parentDeadline = deadlines[deadlines.length - 1];
    if (parentDeadline !== undefined) {
      vm.runtime.setInterruptHandler(makeInterruptHandler(vm, parentDeadline));
    } else {
      quickJSDeadlineStacks.delete(vm);
    }
  }

  if (ok) {
    if (result.error) {
      let error;
      try {
        error = vm.dump(result.error);
      } catch (e) {
        error = e && e.message ? e.message : e;
      } finally {
        result.error.dispose();
      }
      pluginLog(pluginId, "error", label + " failed: " + errorMessage(error));
      ok = false;
    } else if ((quickJSInterruptCounts.get(vm) || 0) > interruptsBefore) {
      // The per-operation deadline fired at least once while this operation ran, yet the guest
      // code returned a normal result instead of unwinding (e.g. it swallowed or survived the
      // "interrupted" exception). A normal-looking return cannot be trusted after an overrun:
      // fail closed exactly as if the operation had thrown (RT-1/RT-2).
      result.value.dispose();
      pluginLog(
        pluginId,
        "error",
        label +
          " exceeded its CPU deadline (" +
          QUICKJS_CPU_DEADLINE_MS +
          "ms) and did not unwind; treating as failure",
      );
      ok = false;
    } else if (requireUndefined && vm.typeof(result.value) !== "undefined") {
      const resultType = vm.typeof(result.value);
      result.value.dispose();
      pluginLog(
        pluginId,
        "error",
        label +
          " rejected asynchronous/non-void lifecycle result (expected undefined, got " +
          resultType +
          ")",
      );
      ok = false;
    } else {
      result.value.dispose();
    }
  }

  if (!ok && !abuseDisabledPlugins.has(pluginId)) {
    const interrupts = quickJSInterruptCounts.get(vm) || 0;
    if (interrupts > QUICKJS_CPU_DEADLINE_INTERRUPT_LIMIT) {
      // Cumulative-CPU kill: this VM has now exhausted more than the allowed number of per-op
      // deadlines. Hard-disable the plugin for the rest of this plan generation instead of only
      // failing the single operation, so repeated callbacks cannot each burn a fresh 1s budget.
      abuseDisabledPlugins.add(pluginId);
      pluginLog(
        pluginId,
        "error",
        label +
          " exceeded the cumulative CPU budget (" +
          QUICKJS_CPU_DEADLINE_INTERRUPT_LIMIT +
          " expired deadlines); plugin disabled until the next plan revision",
      );
    }
  }

  // If this was the outermost operation for a now-disabled main plugin, hard-kill it here: no
  // guest frame is on the stack, so deregistering is safe. Disposal is deferred to the next tick
  // so host code that still holds handles of this VM (e.g. the onCreated callback handler, which
  // disposes its window-id handle right after this operation returns) runs before the VM is freed.
  // This matters for window.onCreated callback timeouts, whose caller would otherwise only
  // unregister the single callback and leave the disabled VM able to burn fresh budgets on later
  // window events. (Eval/activate failures never reach mainPlugins — the caller disposes its VM.)
  if (outerDepth === 0 && abuseDisabledPlugins.has(pluginId)) {
    const entry = mainPlugins.get(pluginId);
    if (entry && entry.vm === vm) {
      setImmediate(() =>
        killMainPlugin(
          pluginId,
          entry,
          label + " exhausted the cumulative CPU budget; main plugin disabled",
        ),
      );
    }
  }
  return ok;
}

function pluginFingerprint(plugin) {
  return JSON.stringify(plugin);
}

function cleanupAll(cleanups) {
  for (const cleanup of [...cleanups]) cleanup();
}

// Test seam: number of VM disposals attempted (exposed via __testing for the bun harness).
let vmDisposeCount = 0;

function disposeVM(vm) {
  try {
    vm.dispose();
  } catch (_e) {
    // Best effort: a failed/interrupted VM must never remain registered.
  }
  vmDisposeCount += 1;
}

// Read the plugin's exported `deactivate` from a live VM, retaining the owned handles needed to
// call it later with the same receiver/ctx shape as activate (this === module.exports). When the
// plugin exports no deactivate, returns empty handles (nothing retained). The caller must dispose
// the returned handles exactly once — in the plugin's deactivate path, while the VM is still alive.
function capturePluginDeactivate(vm) {
  const moduleHandle = vm.getProp(vm.global, "module");
  const exportsHandle = vm.getProp(moduleHandle, "exports");
  moduleHandle.dispose();
  const candidate = vm.getProp(exportsHandle, "deactivate");
  if (vm.typeof(candidate) !== "function") {
    candidate.dispose();
    exportsHandle.dispose();
    return { deactivateExport: null, ctx: null, moduleExports: null };
  }
  return {
    deactivateExport: candidate,
    ctx: vm.getProp(vm.global, "ctx"),
    moduleExports: exportsHandle,
  };
}

// Run the plugin's own module.exports.deactivate(ctx) synchronously — the same undefined-void
// contract as activate (a throwing or non-undefined/Promise result is a failed cleanup, logged,
// and never blocks disposal) — while the VM is still alive. Then run host cleanup and dispose the
// VM. `cleanups` is the main-plugin host-cleanup array (null for renderer plugins).
function deactivatePluginVM(vm, pluginId, label, lifecycle, cleanups) {
  if (lifecycle.deactivateExport) {
    const ok = runQuickJSOperation(vm, pluginId, label + " deactivate", () =>
      vm.callFunction(lifecycle.deactivateExport, lifecycle.moduleExports, lifecycle.ctx),
      true,
    );
    if (!ok) {
      pluginLog(
        pluginId,
        "error",
        label + " deactivate failed or returned a non-undefined result; continuing with disposal",
      );
    }
  }
  for (const handle of [lifecycle.deactivateExport, lifecycle.ctx, lifecycle.moduleExports]) {
    if (handle) {
      try {
        handle.dispose();
      } catch (_e) {
        // Best effort.
      }
    }
  }
  if (cleanups) {
    try {
      cleanupAll(cleanups);
    } catch (_e) {
      // A throwing host cleanup must not prevent VM disposal.
    }
  }
  disposeVM(vm);
}

// Hard kill for a main plugin whose cumulative CPU budget was exhausted: deregister it and
// dispose its VM so no further callback can burn main-thread CPU in this plan generation.
function killMainPlugin(pluginId, entry, reason) {
  // Only kill when `entry` is still the registered instance: a plan revision may have cleared the
  // disabled set and respawned the plugin (new VM) before a deferred kill runs.
  if (mainPlugins.get(pluginId) === entry) {
    mainPlugins.delete(pluginId);
    entry.deactivate();
    pluginLog(pluginId, "error", reason);
  }
}

function buildLogger(vm, pluginId) {
  const logger = vm.newObject();
  for (const level of ["info", "warn", "error"]) {
    const method = vm.newFunction(level, (messageHandle) => {
      if (vm.typeof(messageHandle) === "string") {
        // RT-3 (informational): coercing this handle can invoke the plugin's own toString/valueOf
        // if it passes an object; it runs under the enclosing operation's QuickJS deadline.
        pluginLog(pluginId, level, vm.getString(messageHandle));
      }
      return vm.undefined;
    });
    vm.setProp(logger, level, method);
    method.dispose();
  }
  return logger;
}

function buildWindowApi(vm, app, cleanupCallbacks, pluginId) {
  const win = vm.newObject();

  const onCreated = vm.newFunction("onCreated", (cbHandle) => {
    const callback = cbHandle.dup();
    let registered = true;
    const cleanup = () => {
      if (!registered) return;
      registered = false;
      app.removeListener("browser-window-created", listener);
      callback.dispose();
      const index = cleanupCallbacks.indexOf(cleanup);
      if (index !== -1) cleanupCallbacks.splice(index, 1);
    };
    const invoke = (w) => {
      if (!registered) return false;
      const id = vm.newNumber(w.id);
      try {
        // A callback timeout hard-kills the whole plugin (see runQuickJSOperation): the callback
        // is just one host event, but repeated over-budget callbacks must not each get a fresh 1s
        // budget while the plugin stays registered for further window events.
        const succeeded = runQuickJSOperation(vm, pluginId, "window.onCreated callback", () =>
          vm.callFunction(callback, vm.undefined, id),
          true,
        );
        if (!succeeded) cleanup();
        return succeeded;
      } finally {
        id.dispose();
      }
    };
    // Fire for windows created after registration.
    const listener = (_e, w) => invoke(w);
    app.on("browser-window-created", listener);
    cleanupCallbacks.push(cleanup);
    // Also fire for windows that already exist (the QuickJS sandbox loads async and can
    // miss the first window).
    for (const w of BrowserWindow.getAllWindows()) {
      if (!invoke(w)) break;
    }
    return vm.undefined;
  });
  vm.setProp(win, "onCreated", onCreated);
  onCreated.dispose();

  const setOpacity = vm.newFunction("setOpacity", (winHandle, nHandle) => {
    // RT-3 (informational): vm.getNumber coercion can invoke the plugin's own valueOf/toString;
    // it runs under the enclosing operation's QuickJS deadline, so there is no CPU escape here.
    const id = vm.getNumber(winHandle);
    const n = vm.getNumber(nHandle);
    const w = BrowserWindow.fromId(id);
    if (w) {
      w.setOpacity(n);
      pluginLog(pluginId, "info", "window.setOpacity: window=" + id + " opacity=" + n);
    }
    return vm.undefined;
  });
  vm.setProp(win, "setOpacity", setOpacity);
  setOpacity.dispose();

  const setSize = vm.newFunction("setSize", (winHandle, wHandle, hHandle) => {
    // RT-3 (informational): see setOpacity — value coercion runs under the op's deadline.
    const id = vm.getNumber(winHandle);
    const w = BrowserWindow.fromId(id);
    if (w) w.setSize(vm.getNumber(wHandle), vm.getNumber(hHandle));
    return vm.undefined;
  });
  vm.setProp(win, "setSize", setSize);
  setSize.dispose();

  const setPosition = vm.newFunction("setPosition", (winHandle, xHandle, yHandle) => {
    // RT-3 (informational): see setOpacity — value coercion runs under the op's deadline.
    const id = vm.getNumber(winHandle);
    const w = BrowserWindow.fromId(id);
    if (w) w.setPosition(vm.getNumber(xHandle), vm.getNumber(yHandle));
    return vm.undefined;
  });
  vm.setProp(win, "setPosition", setPosition);
  setPosition.dispose();

  const setVibrancy = vm.newFunction("setVibrancy", (winHandle, materialHandle) => {
    // RT-3 (informational): vm.getString coercion can invoke the plugin's own toString/valueOf on
    // an object handle; it runs under the enclosing operation's QuickJS deadline.
    const id = vm.getNumber(winHandle);
    const material = vm.getString(materialHandle);
    const w = windowResolver(id);
    if (!w) {
      // Invalid window handle: structured error, never a synchronous throw across the bridge.
      pluginLog(pluginId, "error", "window.setVibrancy: unknown window id " + id);
      return vm.undefined;
    }
    if (hostPlatform !== "darwin") {
      // macOS-only (SPEC §10 / docs/PLUGIN-SDK.md): a structured, logged no-op elsewhere.
      pluginLog(
        pluginId,
        "warn",
        "window.setVibrancy: requires macOS (host platform=" + hostPlatform + "); no-op",
      );
      return vm.undefined;
    }
    if (typeof w.setVibrancy !== "function") {
      pluginLog(
        pluginId,
        "error",
        "window.setVibrancy: BrowserWindow#setVibrancy is unavailable in this Electron build; no-op",
      );
      return vm.undefined;
    }
    try {
      w.setVibrancy(material);
      pluginLog(pluginId, "info", "window.setVibrancy: window=" + id + " material=" + material);
    } catch (e) {
      pluginLog(pluginId, "error", "window.setVibrancy failed: " + errorText(e));
    }
    return vm.undefined;
  });
  vm.setProp(win, "setVibrancy", setVibrancy);
  setVibrancy.dispose();

  const setMica = vm.newFunction("setMica", (winHandle, enabledHandle) => {
    // RT-3 (informational): see setVibrancy — coercion runs under the op's deadline.
    const id = vm.getNumber(winHandle);
    const enabled = enabledFromHandle(vm, enabledHandle);
    const w = windowResolver(id);
    if (!w) {
      pluginLog(pluginId, "error", "window.setMica: unknown window id " + id);
      return vm.undefined;
    }
    if (hostPlatform !== "win32") {
      // Windows 11 DWM backdrop only (SPEC §10 / docs/PLUGIN-SDK.md): logged no-op elsewhere.
      pluginLog(
        pluginId,
        "warn",
        "window.setMica: requires Windows (host platform=" + hostPlatform + "); no-op",
      );
      return vm.undefined;
    }
    if (typeof w.setBackgroundMaterial !== "function") {
      pluginLog(
        pluginId,
        "error",
        "window.setMica: BrowserWindow#setBackgroundMaterial is unavailable in this Electron build; no-op",
      );
      return vm.undefined;
    }
    const material = enabled ? "mica" : "none";
    try {
      w.setBackgroundMaterial(material);
      pluginLog(pluginId, "info", "window.setMica: window=" + id + " material=" + material);
    } catch (e) {
      pluginLog(pluginId, "error", "window.setMica failed: " + errorText(e));
    }
    return vm.undefined;
  });
  vm.setProp(win, "setMica", setMica);
  setMica.dispose();

  return win;
}

// setMica's enabled flag is typed boolean in the SDK. QuickJS booleans do not convert through
// getNumber reliably, so read primitives via dump (QTS_Dump of a boolean is a plain "true"/"false"
// — no guest code runs); any other type falls back to numeric coercion and is treated truthy on
// non-zero (same lenient coercion family as the other host functions, bounded by the op deadline).
function enabledFromHandle(vm, handle) {
  if (vm.typeof(handle) === "boolean") return !!vm.dump(handle);
  return vm.getNumber(handle) !== 0;
}

// --- Main-plugin lifecycle events (SPEC §9 MVP) ---
//
// ctx.onLoad(cb) / ctx.onRendererReady(cb) / ctx.onUnload(cb) attach at the MAIN context ROOT
// (not under ctx.window) deliberately. ctx.window is the window *mutation* surface — every member
// consumes a window handle to change a window. These three events announce the plugin host
// lifecycle (the app loaded, a renderer finished loading, a window unloaded) and are not mutations,
// so they live next to the module-level activate/deactivate lifecycle a plugin already implements
// (docs/PLUGIN-SDK.md: Lifecycle), where SPEC §9 lists them. onWindowCreated stays in ctx.window
// because it is the creation counterpart of the mutation handles there.
//
// Contracts are identical to ctx.window.onCreated (docs/PLUGIN-SDK.md "Lifecycle contract"):
//   * callbacks are synchronous, run under runQuickJSOperation with a fresh per-operation CPU
//     deadline, and must return undefined (the undefined-void contract is enforced);
//   * a throwing, over-deadline, or non-void callback fails closed: its own subscription is
//     unregistered so it is never re-invoked on later host events;
//   * every subscription is pushed into the owning plugin's cleanupCallbacks, so revoke/deactivate
//     disposes the dup'd guest callback handle and removes all listeners.
//
// Emit semantics (chosen and documented):
//   * onLoad fires exactly once per subscription — when the target app's main process has finished
//     loading its original app (see start(); app ready/whenReady resolves only after bootstrap's
//     require of the original app registered its own boot code), or immediately at registration if
//     the app already finished loading. No window argument: it is the app-process boot event.
//   * onRendererReady fires per window per did-finish-load (i.e. per navigation), reusing the
//     window record's loaded/rendererGeneration path inside start(); it passes the webContents id.
//     Subscriptions made after a window already loaded fire once for each such window, mirroring
//     onCreated's existing-window replay.
//   * onUnload fires per window when its webContents is destroyed (the runtime's canonical unload
//     point — a quitting app always destroys its windows, so app shutdown is covered by the same
//     path without a separate before-quit wire that would double-fire normal per-window teardown);
//     it passes the webContents id.
function subscribeLifecycle(vm, pluginId, cleanupCallbacks, set, label, once, cbHandle) {
  const callback = cbHandle.dup();
  let registered = true;
  let entry = null;
  const unregister = () => {
    if (!registered) return false;
    registered = false;
    callback.dispose();
    set.delete(entry);
    const index = cleanupCallbacks.indexOf(cleanup);
    if (index !== -1) cleanupCallbacks.splice(index, 1);
    return true;
  };
  const cleanup = () => {
    unregister();
  };
  entry = {
    pluginId,
    vm,
    unregister,
    // argValues are JS numbers (window/contents ids today). Each is converted to a QuickJS handle
    // for the guest call and disposed afterwards, exactly like onCreated's window-id handle.
    invoke: (argValues) => {
      if (!registered) return false;
      const handles = [];
      let succeeded = false;
      try {
        for (const value of argValues || []) handles.push(vm.newNumber(value));
        succeeded = runQuickJSOperation(
          vm,
          pluginId,
          label + " callback",
          () => vm.callFunction(callback, vm.undefined, ...handles),
          true,
        );
      } finally {
        for (const handle of handles) handle.dispose();
      }
      if (!succeeded) unregister();
      else if (once) unregister();
      return succeeded;
    },
  };
  set.add(entry);
  cleanupCallbacks.push(cleanup);
  return entry;
}

// Build and attach ctx.onLoad / ctx.onRendererReady / ctx.onUnload onto the main-plugin ctx object.
// Exposed to every QuickJS main plugin (the reconcile path only loads a main plugin into QuickJS
// when electron.window — or dev-mode runtime.unsafe, which runs raw instead — is granted).
function attachLifecycleApi(vm, ctx, pluginId, cleanupCallbacks) {
  const onLoad = vm.newFunction("onLoad", (cbHandle) => {
    const entry = subscribeLifecycle(
      vm, pluginId, cleanupCallbacks, loadCallbacks, "ctx.onLoad", true, cbHandle,
    );
    if (entry && appLoaded) {
      // The app already finished loading before this plugin subscribed (typical: the plan arrives
      // after app ready). Deliver the boot event synchronously, exactly once.
      entry.invoke([]);
    }
    return vm.undefined;
  });
  vm.setProp(ctx, "onLoad", onLoad);
  onLoad.dispose();

  const onRendererReady = vm.newFunction("onRendererReady", (cbHandle) => {
    const entry = subscribeLifecycle(
      vm, pluginId, cleanupCallbacks, rendererReadyCallbacks, "ctx.onRendererReady", false, cbHandle,
    );
    if (entry) {
      // Replay windows that already finished loading (the QuickJS sandbox loads asynchronously and
      // can miss their did-finish-load), mirroring onCreated's existing-window replay. Future loads
      // reach the subscription through the live did-finish-load dispatch in start().
      for (const w of [...windows.values()]) {
        if (!w.loaded) continue;
        if (!entry.invoke([w.contents.id])) break;
      }
    }
    return vm.undefined;
  });
  vm.setProp(ctx, "onRendererReady", onRendererReady);
  onRendererReady.dispose();

  const onUnload = vm.newFunction("onUnload", (cbHandle) => {
    subscribeLifecycle(
      vm, pluginId, cleanupCallbacks, unloadCallbacks, "ctx.onUnload", false, cbHandle,
    );
    return vm.undefined;
  });
  vm.setProp(ctx, "onUnload", onUnload);
  onUnload.dispose();
}

// The target app's main process finished loading its original app: deliver every pending ctx.onLoad
// exactly once. Guarded so a second signal (e.g. a later ready emission) never double-delivers.
function markAppLoaded() {
  if (appLoaded) return;
  appLoaded = true;
  const pending = [...loadCallbacks];
  loadCallbacks.clear();
  for (const entry of pending) {
    // once: a successful or failed invocation unregisters the entry (fail-closed), so nothing here
    // can fire twice.
    entry.invoke([]);
  }
}

// Per-window renderer-ready dispatch: fires ctx.onRendererReady subscribers for a window whose
// contents finished loading (per navigation — called from the did-finish-load path in start()).
function fireRendererReady(w) {
  if (!w || !w.contents) return;
  for (const entry of [...rendererReadyCallbacks]) {
    entry.invoke([w.contents.id]);
  }
}

// Per-window unload dispatch: fires ctx.onUnload subscribers when a window's webContents is
// destroyed (called from the webContents destroyed path in start()).
function fireWindowUnload(contentsId) {
  for (const entry of [...unloadCallbacks]) {
    entry.invoke([contentsId]);
  }
}

// --- Developer-mode raw plugins (runtime.unsafe) ---
//
// Deliberate, documented exception (docs/PLUGIN-SDK.md, docs/SPEC.md): a plugin whose `granted`
// includes `runtime.unsafe` bypasses the QuickJS sandbox entirely and runs its `main`/`renderer`
// source in this host (main) process via `new Function`. It receives the real Electron and Node
// surfaces (`ctx.raw.electron` / `ctx.raw.node`) with full Node/Electron parity — no QuickJS VM,
// no CPU deadline, no memory/stack limits, and no VM disposal (there is no VM to dispose).
function runRawPlugin(plugin, generation, fingerprint, windowRecord) {
  const renderer = !!windowRecord;
  const key = renderer ? plugin.id + "@" + windowRecord.contents.id : plugin.id;
  const map = renderer ? rendererPlugins : mainPlugins;
  const windowGeneration = renderer ? windowRecord.rendererGeneration : 0;

  const moduleObj = { exports: {} };
  const logger = {};
  for (const level of ["info", "warn", "error"]) {
    logger[level] = (message) => pluginLog(plugin.id, level, message);
  }
  const ctx = {
    logger,
    raw: {
      electron: require("electron"),
      node: { require, process },
    },
  };

  // Full parity: the source sees the host require/process/electron bound as its own frame
  // parameters, plus `ctx` and CommonJS `module`/`exports`.
  try {
    new Function("require", "process", "electron", "ctx", "module", "exports", plugin.main ?? plugin.renderer)(
      require,
      process,
      ctx.raw.electron,
      ctx,
      moduleObj,
      moduleObj.exports,
    );
  } catch (e) {
    // A throwing module body is a failed load: log and do NOT register an active plugin.
    pluginLog(plugin.id, "error", "raw plugin activate failed: " + errorText(e));
    return;
  }

  if (typeof moduleObj.exports.activate === "function") {
    try {
      moduleObj.exports.activate(ctx);
    } catch (e) {
      pluginLog(plugin.id, "error", "raw plugin activate failed: " + errorText(e));
      return;
    }
  }

  // Same plan-generation / abuse-disabled / window guards as the async QuickJS loaders: register
  // only while this plan generation still wants exactly this fingerprint and the key is free.
  // Registration is synchronous, so a newer plan cannot interleave mid-load; the check keeps the
  // contract explicit (a superseded raw load must never become an active plugin).
  const stillWanted =
    generation === planGeneration &&
    !abuseDisabledPlugins.has(plugin.id) &&
    !map.has(key) &&
    currentPlan.plugins.some(
      (candidate) =>
        candidate.id === plugin.id &&
        (renderer ? candidate.renderer : candidate.main) &&
        (hasPermission(candidate.granted, renderer ? "renderer.script" : "electron.window") ||
          hasPermission(candidate.granted, "runtime.unsafe")) &&
        pluginFingerprint(candidate) === fingerprint,
    ) &&
    (!renderer ||
      (windowRecord.rendererGeneration === windowGeneration &&
        windows.get(windowRecord.contents.id) === windowRecord));
  if (!stillWanted) {
    return;
  }

  // Same lifecycle contract as QuickJS plugins: deactivation runs the plugin's own
  // module.exports.deactivate(ctx) synchronously, guarded so a stale double revoke never calls it
  // twice, then drops the entry. No VM exists for raw plugins, so there is nothing to dispose.
  const lifecycleDeactivate =
    typeof moduleObj.exports.deactivate === "function" ? moduleObj.exports.deactivate : null;
  let deactivated = false;
  const deactivate = () => {
    if (deactivated) return;
    deactivated = true;
    if (lifecycleDeactivate) {
      try {
        lifecycleDeactivate(ctx);
      } catch (e) {
        pluginLog(plugin.id, "error", "raw plugin deactivate failed: " + errorText(e));
      }
    }
    map.delete(key);
  };
  map.set(key, { deactivate, fingerprint });
  pluginLog(plugin.id, "info", "Raw plugin loaded (developer mode)");
}

function runMainPlugin(plugin, app, generation, fingerprint) {
  // Developer-mode raw plugin: bypass the QuickJS sandbox entirely (see runRawPlugin).
  if (hasPermission(plugin.granted, "runtime.unsafe")) {
    return runRawPlugin(plugin, generation, fingerprint);
  }
  if (abuseDisabledPlugins.has(plugin.id)) {
    // Killed earlier in this plan generation for exceeding the cumulative CPU budget; do not
    // respawn it just because a later reconcile still wants it.
    return;
  }
  const pending = { generation, fingerprint };
  let vm = null;
  const cleanupCallbacks = [];
  pendingMainPlugins.set(plugin.id, pending);
  getQuickJS().then((QuickJS) => {
    if (pendingMainPlugins.get(plugin.id) !== pending) return;
    pendingMainPlugins.delete(plugin.id);

    vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);
    vm.runtime.setMaxStackSize(1024 * 512);

    const ctx = vm.newObject();
    const logger = buildLogger(vm, plugin.id);
    vm.setProp(ctx, "logger", logger);
    logger.dispose();
    // SPEC §9 MVP lifecycle events attach at the main context root (see attachLifecycleApi for the
    // rationale and emit semantics). Only the sandboxed main path exposes them; the raw dev-mode
    // ctx stays minimal ({ logger, raw }) so this does not widen the runtime.unsafe surface.
    attachLifecycleApi(vm, ctx, plugin.id, cleanupCallbacks);
    if (hasPermission(plugin.granted, "electron.window")) {
      const win = buildWindowApi(vm, app, cleanupCallbacks, plugin.id);
      vm.setProp(ctx, "window", win);
      win.dispose();
    }
    vm.setProp(vm.global, "ctx", ctx);
    ctx.dispose();

    // CommonJS-style module scaffolding so the plugin can `module.exports = {...}`.
    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    vm.setProp(vm.global, "exports", exportsObj);
    moduleObj.dispose();
    exportsObj.dispose();

    if (
      !runQuickJSOperation(vm, plugin.id, "main plugin eval", () =>
        vm.evalCode(plugin.main || ""),
      )
    ) {
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    // Call module.exports.activate(ctx) if present. Read `module.exports` (not the stale
    // `global.exports`) because the plugin assigns `module.exports = {...}`.
    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    let activated = true;
    if (vm.typeof(activate) === "function") {
      activated = runQuickJSOperation(vm, plugin.id, "main plugin activate", () =>
        vm.callFunction(activate, exportsHandle, ctxHandle),
        true,
      );
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    if (!activated) {
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    const stillPending =
      generation === planGeneration &&
      currentPlan.plugins.some(
        (candidate) =>
          candidate.id === plugin.id &&
          candidate.main &&
          hasPermission(candidate.granted, "electron.window") &&
          pluginFingerprint(candidate) === fingerprint,
      ) &&
      !abuseDisabledPlugins.has(plugin.id) &&
      !mainPlugins.has(plugin.id);
    if (!stillPending) {
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    // Store the vm for later deactivate/disposal. First deactivation runs the plugin's own
    // module.exports.deactivate(ctx) synchronously while the VM is still alive, then host cleanup,
    // then VM disposal. The guard ensures a stale double revoke never calls guest deactivate twice.
    const lifecycle = capturePluginDeactivate(vm);
    let deactivated = false;
    const deactivate = () => {
      if (deactivated) return;
      deactivated = true;
      deactivatePluginVM(vm, plugin.id, "main plugin", lifecycle, cleanupCallbacks);
    };
    mainPlugins.set(plugin.id, { vm, deactivate, fingerprint });
    pluginLog(plugin.id, "info", "Main plugin loaded");
  }).catch((e) => {
    if (pendingMainPlugins.get(plugin.id) === pending) pendingMainPlugins.delete(plugin.id);
    cleanupAll(cleanupCallbacks);
    if (vm) disposeVM(vm);
    pluginLog(plugin.id, "error", "QuickJS init failed: " + (e && e.message ? e.message : e));
  });
}

// --- Renderer-plugin sandbox (runs per window on did-finish-load) ---

function runRendererPlugin(plugin, w, generation, fingerprint) {
  // Developer-mode raw plugin: bypass the QuickJS sandbox entirely (see runRawPlugin). The window
  // record is passed along so the plugin registers under its per-window key and respects the
  // rendererGeneration guard, exactly like the QuickJS renderer loaders.
  if (hasPermission(plugin.granted, "runtime.unsafe")) {
    return runRawPlugin(plugin, generation, fingerprint, w);
  }
  if (abuseDisabledPlugins.has(plugin.id)) {
    // Killed earlier in this plan generation for exceeding the cumulative CPU budget; do not
    // respawn a new VM for every window in this plan generation.
    return;
  }
  const contents = w.contents;
  const key = plugin.id + "@" + contents.id;
  const pending = { generation, windowGeneration: w.rendererGeneration, fingerprint };
  let vm = null;
  pendingRendererPlugins.set(key, pending);
  getQuickJS().then((QuickJS) => {
    if (pendingRendererPlugins.get(key) !== pending) return;
    pendingRendererPlugins.delete(key);

    vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);
    vm.runtime.setMaxStackSize(1024 * 512);

    const ctx = vm.newObject();
    const logger = buildLogger(vm, plugin.id);
    vm.setProp(ctx, "logger", logger);
    logger.dispose();
    if (hasPermission(plugin.granted, "renderer.script")) {
      const script = vm.newObject();
      const setDocumentTitle = vm.newFunction("setDocumentTitle", (titleHandle) => {
        // RT-3 (informational): vm.getString coercion can invoke the plugin's own toString/valueOf
        // on an object handle; it runs under the enclosing operation's QuickJS deadline.
        const title = vm.getString(titleHandle);
        // The assignment is host-owned. Plugin input is only inserted after JSON serialization,
        // so it can never become executable JavaScript source.
        const assignment = `document.title = ${JSON.stringify(title)}`;
        contents
          .executeJavaScript(assignment)
          .then(() => pluginLog(plugin.id, "info", "script.setDocumentTitle ran"))
          .catch((e) =>
            pluginLog(plugin.id, "error", "script.setDocumentTitle failed: " + (e && e.message ? e.message : e)),
          );
        return vm.undefined;
      });
      vm.setProp(script, "setDocumentTitle", setDocumentTitle);
      setDocumentTitle.dispose();
      vm.setProp(ctx, "script", script);
      script.dispose();
    }
    // (ctx.dom.query / ctx.dom.observe need async host functions — future.)
    vm.setProp(vm.global, "ctx", ctx);
    ctx.dispose();

    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    vm.setProp(vm.global, "exports", exportsObj);
    moduleObj.dispose();
    exportsObj.dispose();

    if (
      !runQuickJSOperation(vm, plugin.id, "renderer plugin eval", () =>
        vm.evalCode(plugin.renderer || ""),
      )
    ) {
      disposeVM(vm);
      return;
    }

    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    let activated = true;
    if (vm.typeof(activate) === "function") {
      activated = runQuickJSOperation(vm, plugin.id, "renderer plugin activate", () =>
        vm.callFunction(activate, exportsHandle, ctxHandle),
        true,
      );
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    if (!activated) {
      disposeVM(vm);
      return;
    }

    const stillWanted =
      generation === planGeneration &&
      w.rendererGeneration === pending.windowGeneration &&
      windows.get(contents.id) === w &&
      currentPlan.plugins.some(
        (candidate) =>
          candidate.id === plugin.id &&
          candidate.renderer &&
          hasPermission(candidate.granted, "renderer.script") &&
          pluginFingerprint(candidate) === fingerprint,
      ) &&
      !abuseDisabledPlugins.has(plugin.id) &&
      !rendererPlugins.has(key);
    if (!stillWanted) {
      disposeVM(vm);
      return;
    }

    // Same lifecycle contract as main plugins: deactivation first runs the plugin's own
    // module.exports.deactivate(ctx) synchronously while the VM is still alive, then disposes the
    // VM. Guarded so a stale double revoke never calls guest deactivate twice.
    const lifecycle = capturePluginDeactivate(vm);
    let deactivated = false;
    const deactivate = () => {
      if (deactivated) return;
      deactivated = true;
      deactivatePluginVM(vm, plugin.id, "renderer plugin", lifecycle, null);
    };
    rendererPlugins.set(key, { vm, fingerprint, deactivate });
    pluginLog(plugin.id, "info", "Renderer plugin loaded");
  }).catch((e) => {
    if (pendingRendererPlugins.get(key) === pending) pendingRendererPlugins.delete(key);
    if (vm) disposeVM(vm);
    pluginLog(plugin.id, "error", "QuickJS init failed: " + (e && e.message ? e.message : e));
  });
}

function reconcileRendererPlugins(w) {
  const contents = w.contents;
  const wanted = new Map();
  for (const p of currentPlan.plugins) {
    if (p.renderer && (hasPermission(p.granted, "renderer.script") || hasPermission(p.granted, "runtime.unsafe"))) {
      wanted.set(p.id, { plugin: p, fingerprint: pluginFingerprint(p) });
    }
  }

  for (const [pid, want] of wanted) {
    const key = pid + "@" + contents.id;
    const active = rendererPlugins.get(key);
    if (active && active.fingerprint !== want.fingerprint) {
      rendererPlugins.delete(key);
      active.deactivate();
    }
    const pending = pendingRendererPlugins.get(key);
    if (
      pending &&
      (pending.generation !== planGeneration ||
        pending.windowGeneration !== w.rendererGeneration ||
        pending.fingerprint !== want.fingerprint)
    ) {
      pendingRendererPlugins.delete(key);
    }
    if (!rendererPlugins.has(key) && !pendingRendererPlugins.has(key)) {
      runRendererPlugin(want.plugin, w, planGeneration, want.fingerprint);
    }
  }

  const suffix = "@" + contents.id;
  for (const [key, entry] of rendererPlugins) {
    if (key.endsWith(suffix) && !wanted.has(key.slice(0, -suffix.length))) {
      rendererPlugins.delete(key);
      entry.deactivate();
    }
  }
  for (const key of pendingRendererPlugins.keys()) {
    if (key.endsWith(suffix) && !wanted.has(key.slice(0, -suffix.length))) {
      pendingRendererPlugins.delete(key);
    }
  }
}

function cleanupRendererPlugins(contentsId) {
  const suffix = "@" + contentsId;
  for (const key of pendingRendererPlugins.keys()) {
    if (key.endsWith(suffix)) pendingRendererPlugins.delete(key);
  }
  for (const [key, entry] of rendererPlugins) {
    if (key.endsWith(suffix)) {
      rendererPlugins.delete(key);
      entry.deactivate();
    }
  }
}

function reconcileMainPlugins(app) {
  const wanted = new Map();
  for (const p of currentPlan.plugins) {
    if (p.main && (hasPermission(p.granted, "electron.window") || hasPermission(p.granted, "runtime.unsafe"))) {
      const fingerprint = pluginFingerprint(p);
      wanted.set(p.id, { plugin: p, fingerprint });
      const active = mainPlugins.get(p.id);
      if (active && active.fingerprint !== fingerprint) {
        mainPlugins.delete(p.id);
        active.deactivate();
      }
      const pending = pendingMainPlugins.get(p.id);
      if (
        pending &&
        (pending.generation !== planGeneration || pending.fingerprint !== fingerprint)
      ) {
        pendingMainPlugins.delete(p.id);
      }
      if (!mainPlugins.has(p.id) && !pendingMainPlugins.has(p.id)) {
        runMainPlugin(p, app, planGeneration, fingerprint);
      }
    }
  }
  for (const [pid, entry] of mainPlugins) {
    if (!wanted.has(pid)) {
      mainPlugins.delete(pid);
      entry.deactivate();
      pluginLog(pid, "info", "Main plugin removed");
    }
  }
  for (const pid of pendingMainPlugins.keys()) {
    if (!wanted.has(pid)) pendingMainPlugins.delete(pid);
  }
}

// --- plan application ---

function applyPlan(plan) {
  if (!plan || plan.revision === currentPlan.revision) {
    return;
  }
  currentPlan = plan;
  planGeneration += 1;
  // A new plan revision is an explicit (admin) reconfiguration: plugins disabled by cumulative
  // CPU abuse get one clean reload under the new plan.
  abuseDisabledPlugins.clear();
  for (const w of windows.values()) {
    reconcile(w);
    if (w.loaded) reconcileRendererPlugins(w);
  }
  reconcileMainPlugins(appRef);
}

// --- plan acquisition and polling ---
//
// This loop lives in the Runtime (not the Injector bootstrap) per docs/AGENTS.md layering:
// Injector only establishes comms, so the bootstrap hands us a `request(method, params, options)`
// transport built once around connect/send/frame parsing. Everything about the plan contract —
// the version/id/result/error response-envelope checks, the plan payload shape, the polling
// cadence, and reconnect logging — is owned here with the loop. The bootstrap keeps the log
// delivery queue because that is transport.

const IPC_VERSION = "0.1";
const PLAN_POLL_INTERVAL_MS = 2000;
const PLAN_POLL_TIMEOUT_MS = 5000;

// `request` transport (injected by the bootstrap). Resolves to `{ id, envelope }` where `id` is
// the request id the transport sent and `envelope` is the raw parsed JSON-RPC response.
let planRequest = null;
let planPollTimer = null;
let planPolling = false;
let lastPlanPollError = null;

// Envelope validation (version/id/result/error). Throws on any violation; returns the result.
function validatePlanEnvelope(envelope, expectedId) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("invalid IPC response");
  }
  if (envelope.version !== IPC_VERSION || envelope.id !== expectedId) {
    throw new Error("invalid IPC response");
  }
  if (envelope.error) {
    throw new Error(JSON.stringify(envelope.error));
  }
  return envelope.result;
}

function pollPlan() {
  if (planPolling || !planRequest) return;
  planPolling = true;
  planRequest("getExecutionPlan", {}, { timeout: PLAN_POLL_TIMEOUT_MS })
    .then(({ id, envelope }) => {
      // Envelope contract first: a malformed envelope or a Core error must not count as a
      // recovery, so reconnect is only reported once a structurally valid plan response arrives.
      const plan = validatePlanEnvelope(envelope, id);
      if (lastPlanPollError !== null) {
        log("Core reconnected");
        lastPlanPollError = null;
      }
      if (!plan || !Array.isArray(plan.plugins)) {
        log("invalid plan payload from Core; ignoring", "warn");
        return;
      }
      applyPlan(plan);
    })
    .catch((e) => {
      const message = e && e.message ? e.message : String(e);
      if (lastPlanPollError !== message) {
        log("poll failed: " + message, "warn");
        lastPlanPollError = message;
      }
    })
    .then(() => {
      planPolling = false;
    });
}

function startPlanPolling(request) {
  if (planPollTimer) return;
  planRequest = request;
  pollPlan();
  planPollTimer = setInterval(pollPlan, PLAN_POLL_INTERVAL_MS);
}

function start(app, sinks = {}) {
  if (typeof sinks.runtimeLog === "function") runtimeLogSink = sinks.runtimeLog;
  if (typeof sinks.pluginLog === "function") pluginLogSink = sinks.pluginLog;
  if (typeof sinks.request === "function") {
    startPlanPolling(sinks.request);
  } else {
    log("no plan request transport supplied; plan polling disabled", "warn");
  }
  appRef = app;

  // Lifecycle boot event (SPEC §9 onLoad): mark the target app's main process as loaded once the
  // app is ready. bootstrap.js calls runtime.start(...) and THEN requires the original app, so the
  // original app's own boot code (its ready handlers / whenReady consumers) is registered before
  // Electron emits ready — delivering onLoad only after the original app finished loading. On real
  // Electron use app.whenReady() (its resolution runs after the ready event's synchronous dispatch
  // and never double-fires); stub/test hosts without whenReady fall back to the ready event.
  if (app && typeof app.whenReady === "function") {
    app.whenReady().then(markAppLoaded).catch((e) => {
      log("app-ready tracking failed: " + (e && e.message ? e.message : e), "warn");
    });
  } else if (app && typeof app.once === "function") {
    app.once("ready", markAppLoaded);
  }

  // Adapter (compat profile) selection and onBootstrap. Critical ordering invariant: this runs
  // synchronously inside start(), so it happens BEFORE bootstrap.js requires the original target
  // app (bootstrap.js: runtime.start(...) then require(originalAsar)). Phase B adapters hook
  // protocol.handle here. Fail-open: never crash the target.
  try {
    // Adapter-facing logger is level-first; the runtime log() is (message, level).
    adapters.init({ log: (level, message) => log(message, level) });
    const appInfo = adapters.buildAppInfo(app);
    const adapter = adapters.select(appInfo);
    // Set BEFORE the `if (adapter)` block: the web-contents-created/did-finish-load handlers are
    // registered below and consult activeAdapter for the optional renderer.gate timing seam.
    activeAdapter = adapter;
    if (adapter) {
      const ctx = {
        app,
        appInfo,
        protocol: require("electron").protocol,
        log: (level, message) => log(message, level),
      };
      adapters.runOnBootstrap(adapter, ctx);
      log("adapter active: " + adapter.id);
    } else {
      log("no compat adapter matched", "warn");
    }
  } catch (e) {
    log("compat adapter bootstrap failed: " + (e && e.message ? e.message : e), "error");
  }

  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "window") {
      return;
    }
    const w = {
      contents,
      keys: new Map(),
      gens: new Map(),
      loaded: false,
      rendererGeneration: 0,
    };
    windows.set(contents.id, w);
    contents.on("destroyed", () => {
      const contentsId = contents.id;
      windows.delete(contentsId);
      cleanupRendererPlugins(contentsId);
      // Main-plugin lifecycle (SPEC §9 onUnload): fires per window when its webContents is
      // destroyed. A quitting app always destroys its windows, so app shutdown reaches the same
      // path — a separate before-quit wire would double-fire normal per-window teardown.
      fireWindowUnload(contentsId);
    });
    contents.on("did-finish-load", () => {
      // Path A renderer-timing seam: the active adapter may opt into `renderer.gate(win, ready)`
      // to delay injection until the app's OWN UI-ready signal (e.g. Obsidian's `.workspace`).
      // `win` is this window record; `ready()` runs the existing reconcile. Fail-open: the gate
      // must call ready() exactly once within a bounded timeout (makeSelectorGate), and a throwing
      // gate falls back to the default timing below.
      const onReady = () => {
        w.loaded = true;
        w.rendererGeneration += 1;
        cleanupRendererPlugins(contents.id);
        reconcile(w);
        reconcileRendererPlugins(w);
        // Main-plugin lifecycle (SPEC §9 onRendererReady): fires per window per did-finish-load
        // (per navigation), after the window record reached the loaded state. Adapter gates call
        // this exact onReady (see above), so gated timing applies to the event as well.
        fireRendererReady(w);
      };
      const gate =
        activeAdapter &&
        activeAdapter.renderer &&
        typeof activeAdapter.renderer.gate === "function"
          ? activeAdapter.renderer.gate
          : null;
      if (gate) {
        try {
          gate(w, onReady);
          return;
        } catch (e) {
          log("adapter renderer.gate threw; using default timing: " + (e && e.message ? e.message : e), "warn");
        }
      }
      onReady();
    });
  });
}

// --- test seams ---
//
// The public contract is `module.exports = { start, applyPlan }`; the extra keys below exist only
// for the repeatable bun harness (src/index.test.js) and are inert in the bundled runtime.

function reset() {
  if (planPollTimer) {
    clearInterval(planPollTimer);
    planPollTimer = null;
  }
  planRequest = null;
  planPolling = false;
  lastPlanPollError = null;
  currentPlan = { revision: "", plugins: [] };
  planGeneration = 0;
  windows.clear();
  appRef = null;
  activeAdapter = null;
  mainPlugins.clear();
  pendingMainPlugins.clear();
  rendererPlugins.clear();
  pendingRendererPlugins.clear();
  abuseDisabledPlugins.clear();
  vmDisposeCount = 0;
  quickJSGetCount = 0;
  loadCallbacks.clear();
  rendererReadyCallbacks.clear();
  unloadCallbacks.clear();
  appLoaded = false;
  hostPlatform = process.platform;
  windowResolver = (id) => BrowserWindow.fromId(id);
}

module.exports = {
  start,
  applyPlan,
  __testing: {
    reset,
    mainPlugins: () => mainPlugins,
    rendererPlugins: () => rendererPlugins,
    windows: () => windows,
    vmDisposeCount: () => vmDisposeCount,
    quickJSGetCount: () => quickJSGetCount,
    // Platform gate seam for the bun harness: lets tests exercise the macOS/Windows-only host
    // functions (setVibrancy/setMica) on any host. reset() restores the real host platform.
    setPlatform: (platform) => {
      hostPlatform = platform;
    },
    // Window-resolution seam for the bun harness: `bun test` shares one module registry across
    // files, so index.js captures whichever test file's "electron" stub loaded first and a later
    // file cannot rely on its own electron stub identity. Tests point this at their fake window
    // map to exercise the setVibrancy/setMica handle resolution hermetically. reset() restores the
    // production Electron BrowserWindow.fromId behavior.
    setWindowResolver: (resolver) => {
      windowResolver = typeof resolver === "function" ? resolver : (id) => BrowserWindow.fromId(id);
    },
  },
};

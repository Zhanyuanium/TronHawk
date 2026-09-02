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

function hasPermission(granted, perm) {
  return Array.isArray(granted) && granted.includes(perm);
}

// --- CSS injection ---

function inject(w, pid, css) {
  const gen = (w.gens.get(pid) || 0) + 1;
  w.gens.set(pid, gen);

  const old = w.keys.get(pid);
  w.keys.delete(pid);
  const removeOld = old
    ? w.contents.removeInsertedCSS(old.key).catch(() => {})
    : Promise.resolve();

  removeOld
    .then(() => w.contents.insertCSS(css))
    .then((key) => {
      if (w.gens.get(pid) !== gen) {
        w.contents.removeInsertedCSS(key).catch(() => {});
        return;
      }
      w.keys.set(pid, { css, key });
      pluginLog(pid, "info", "CSS injected");
    })
    .catch((e) => pluginLog(pid, "error", "CSS injection failed: " + (e && e.message ? e.message : e)));
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
      w.gens.set(pid, (w.gens.get(pid) || 0) + 1);
      const entry = w.keys.get(pid);
      if (entry) {
        w.keys.delete(pid);
        w.contents.removeInsertedCSS(entry.key).catch(() => {});
        pluginLog(pid, "info", "CSS removed");
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
function getQuickJS() {
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

function disposeVM(vm) {
  try {
    vm.dispose();
  } catch (_e) {
    // Best effort: a failed/interrupted VM must never remain registered.
  }
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

  return win;
}

function runMainPlugin(plugin, app, generation, fingerprint) {
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

    // Store the vm for later deactivate/disposal.
    const deactivate = () => {
      try {
        cleanupAll(cleanupCallbacks);
        disposeVM(vm);
      } catch (e) {
        /* ignore */
      }
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

    rendererPlugins.set(key, {
      vm,
      fingerprint,
      deactivate: () => {
        disposeVM(vm);
      },
    });
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
    if (p.renderer && hasPermission(p.granted, "renderer.script")) {
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
    if (p.main && hasPermission(p.granted, "electron.window")) {
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
      windows.delete(contents.id);
      cleanupRendererPlugins(contents.id);
    });
    contents.on("did-finish-load", () => {
      w.loaded = true;
      w.rendererGeneration += 1;
      cleanupRendererPlugins(contents.id);
      reconcile(w);
      reconcileRendererPlugins(w);
    });
  });
}

module.exports = { start, applyPlan };

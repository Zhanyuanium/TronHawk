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
// Original BrowserWindow constructor, captured before any adapter may wrap it (see the
// onWindowOptions/WCO seam in start()). The wrapping constructor always constructs through this
// real reference, so re-wrapping is idempotent and instanceof semantics are preserved.
const RealBrowserWindow = BrowserWindow;

// Compat adapter (compat profile) loader — see src/adapters.js. Adapters are trusted runtime
// substrate statically bundled into runtime.js (never loaded from disk, never installable), and
// their selection/bootstrap runs synchronously inside start(), BEFORE bootstrap.js requires the
// original target app.
const adapters = require("./adapters");

// electron module-resolution shim (ADR 0009). require("electron").BrowserWindow is a
// configurable:false getter-only accessor, so direct assignment silently no-ops. This shim wraps
// require("module")._load to hand out a Proxy facade whose BrowserWindow getter returns a wrapping
// constructor — the only way to rewrite window options before the real constructor runs.
const shim = require("./electron-require-shim");

// Host-hosted declarative window-controls overlay (electron.windowControls).
// The template + pure helpers live in window-controls.js (never an ADAPTERS
// generic adapter; wco.js behavior unchanged).
const windowControls = require("./window-controls");

// Implemented capability sets (mirror crates/core/src/daemon.rs
// IMPLEMENTED_* — the runtime itself gates only by `granted`, Core having
// already intersected with the support level). Level ownership:
// `electron.windowControls` is Level 2 (not Level 1, not developer-only);
// devMode adds only `runtime.unsafe`.
const IMPLEMENTED_RENDERER_CAPABILITIES = ["renderer.css", "renderer.script"];
const IMPLEMENTED_LEVEL_TWO_CAPABILITIES = [
  "renderer.css",
  "renderer.script",
  "renderer.dom",
  "renderer.storage",
  "electron.window",
  "electron.windowControls",
  "network.access",
];
const IMPLEMENTED_LEVEL_TWO_DEVELOPER_CAPABILITIES = [
  ...IMPLEMENTED_LEVEL_TWO_CAPABILITIES,
  "runtime.unsafe",
];

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
// Host-internal surfaces (window-controls overlay views) excluded from target
// discovery. The overlay's WebContents reports getType() === "window" exactly
// like a real target, so type filtering alone cannot exclude it:
// - internalOverlayConstructionDepth: synchronous guard held while
//   `new WebContentsView()` runs; covers `web-contents-created` fired
//   re-entrantly inside construction (before the fresh contents exists).
// - internalOverlayContents: live overlay WebContents registry; covers
//   later/async emissions. Entries are removed when the view is destroyed.
const internalOverlayContents = new Set();
let internalOverlayConstructionDepth = 0;
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

// Live-window enumeration for window-handle issuance (BrowserWindow.id lookup
// from a webContents.id) and for the webContents-id fallback in
// resolveWindowHandle. Evaluated lazily per call (never captured): production
// always enumerates the real Electron windows, while the bun harness replaces
// it via __testing (setWindowEnumerator) for the same module-registry reason
// as windowResolver above. reset() restores this default.
function defaultWindowEnumerator() {
  try {
    const all = BrowserWindow.getAllWindows();
    return Array.isArray(all) ? all : [];
  } catch (_e) {
    return [];
  }
}
let windowEnumerator = defaultWindowEnumerator;

// WindowHandle strategy (Gate 3 attempt-4: cross-namespace collision).
//
// Candidate (b) — "Electron's two id spaces cannot collide" — is false, so
// this host picks (a): unified issuance of BrowserWindow.id.
//
// Proof that the spaces collide (not speculation): BrowserWindow.id comes from
// Electron's NativeWindow::next_id_ (shell/browser/native_window.cc) and
// webContents.id from content::WebContents' independent counter. They are not
// a shared sequence. The first window often has both equal to 1 (same window,
// harmless), but the counters diverge as soon as any extra WebContents exists
// (BrowserView, webview, background page, DevTools). Then window B's
// BrowserWindow.id can equal window A's webContents.id. Fixture used by the
// regression test: A {id:100, webContents.id:1} vs B {id:1, webContents.id:2}.
// A's renderer handle 1 under the old mixed-id scheme is BrowserWindow.fromId(1)
// → B. Changing WindowHandle's TypeScript type to `number` does not fix this:
// the value is still a bare integer from two namespaces.
//
// Candidate (a) payload-carries-namespace (tagged strings / objects) was
// rejected here: WindowHandle stays a number (SDK contract, plugins stringify
// handles, window ops read via vm.getNumber), and tagging would rewrite every
// rr:/ul: assertion plus VIBRANCY-style bare-number ops. Unified issuance
// keeps the numeric contract.
//
// Issuance (issuedWindowHandle):
//   * onCreated already passed BrowserWindow.id — unchanged.
//   * onRendererReady / onUnload now pass the bound BrowserWindow.id when a
//     live BrowserWindow is associated with the contents (stashed on the
//     window record, or looked up via the enumerator). Same window → same
//     number from all three events, and fromId resolves it.
//   * Contents-only path (no live BrowserWindow, the rr:/ul: tests that never
//     register one): keep issuing webContents.id so those assertions stay
//     numeric-identical. Window ops on that handle fail-closed (fromId miss
//     and no window to scan).
//
// Old numeric handles remain readable: resolveWindowHandle still accepts a
// bare number as BrowserWindow.id (fromId) and, on miss, as webContents.id
// (scan). A plugin that reconstructs a webContents.id which equals some other
// window's BrowserWindow.id still hits fromId first — that leftover only
// applies to reconstructed ids, not to newly issued handles. Explicit
// fail-closed for unknown ids is unchanged (structured no-op, never a throw).
//
// `__testing.setWindowHandleMode("legacy-mixed-ids")` restores the old
// issuance (rr/ul pass webContents.id) so the A/B fixture reproduces the
// misroute. Production and reset() stay on "unified-window-id".
const WINDOW_HANDLE_MODE_UNIFIED = "unified-window-id";
const WINDOW_HANDLE_MODE_LEGACY = "legacy-mixed-ids";
let windowHandleMode = WINDOW_HANDLE_MODE_UNIFIED;

function enumerateLiveWindows() {
  let all = [];
  try {
    all = windowEnumerator() || [];
  } catch (_e) {
    all = [];
  }
  return Array.isArray(all) ? all : [];
}

function liveBrowserWindowForContentsId(contentsId) {
  if (typeof contentsId !== "number") return null;
  for (const w of enumerateLiveWindows()) {
    if (w && w.webContents && w.webContents.id === contentsId) return w;
  }
  return null;
}

function stashBrowserWindowId(record, win) {
  if (record && win && typeof win.id === "number") {
    record.browserWindowId = win.id;
  }
}

function issuedWindowHandle(record, contentsIdFallback) {
  const contentsId =
    record && record.contents && typeof record.contents.id === "number"
      ? record.contents.id
      : contentsIdFallback;
  if (windowHandleMode === WINDOW_HANDLE_MODE_LEGACY) {
    return typeof contentsId === "number" ? contentsId : null;
  }
  if (record && typeof record.browserWindowId === "number") {
    return record.browserWindowId;
  }
  const live = liveBrowserWindowForContentsId(contentsId);
  if (live && typeof live.id === "number") {
    stashBrowserWindowId(record, live);
    return live.id;
  }
  return typeof contentsId === "number" ? contentsId : null;
}

// Window op resolution. Newly issued handles are BrowserWindow.id when a
// window is bound, so step 1 hits. Step 2 remains for old numeric webContents
// ids and the contents-only issuance fallback (readable compatibility on miss).
// Unknown ids resolve to null — structured no-op / logged-error, never a throw.
// Destroyed-window corner: a destroyed window has left getAllWindows() and
// fromId, so a late handle is an ordinary unknown id, never a crash.
function resolveWindowHandle(id) {
  let direct = null;
  try {
    direct = windowResolver(id);
  } catch (_e) {
    direct = null;
  }
  if (direct) return direct;
  for (const w of enumerateLiveWindows()) {
    if (w && w.webContents && w.webContents.id === id) return w;
  }
  return null;
}

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

// --- A3 background close path (close-latency redesign) ---
//
// The window-destroyed handler transfers per-window teardown off the Electron close path:
// destroyed returns after synchronous bookkeeping only (record transfer, map removal, VM
// sealing, subscription snapshot, batch enqueue). Guest deactivate / QuickJS disposal /
// onUnload delivery run in a round-robin background pump (setImmediate chain), so the
// native window is gone at baseline speed. Observable order (deactivate before onUnload)
// is preserved inside each window's batch; see fireUnloadSnapshot.
//
// Permanent safety premises (R2): at most MAX_RENDERER_PLUGINS_PER_WINDOW renderer plugins
// per window (fail-closed refuse at load); QuickJS work stays on the owning (main) thread.
const MAX_RENDERER_PLUGINS_PER_WINDOW = 8;
// Sealed VMs: after their window transfers, no async source except the owning teardown batch
// may create QuickJS handles, drain jobs, or invoke guest code on them. teardownActive marks
// the single VM the background pump is currently servicing (its own drain is legitimate).
const vmSealed = new WeakSet();
const teardownActive = new WeakSet();
// Transferred-window close batches, FIFO. Each batch: { handle, contentsId, seq,
// actSnaps: [{ key, pluginId, vm, lifecycle, cleanups }], unloadSnap: [unloadEntry...] }.
const closeQueue = [];
let closePumpScheduled = false;
let closeSeqCounter = 0;
// Quit-mode switch (R1 exit semantics). Set on before-quit; gates NEW allocations only —
// never flushes, never emits. Cleared when host life demonstrably continues (new window
// content created / loaded after a cancelled quit) or on reset().
let quitting = false;

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

// --- Async-op job pump (Tier-2 primitives; ADR 0008 Option B) ---
//
// The sync QuickJS variant never runs promise jobs on its own, so an async host API (network
// request, DOM snapshot, storage read — and, later, Promise-returning lifecycle) must be
// *host-driven*. A host function that cannot answer synchronously creates a deferred via
// newHostPromise() and registers it in pendingOps; when the underlying host operation completes it
// calls settleOp() to resolve/reject the deferred, then drainPendingJobs() to let the plugin's
// continuation run under the usual per-operation CPU deadline.
//
// Lifetime rules:
//   * An op's deferred is disposed exactly once — in settleOp() after settlement, or in
//     cleanupPendingOps() when its VM is disposed while the op is still pending.
//   * settleOp() owns the QuickJS value handle produced by its `makeHandle` callback and disposes it
//     after resolving/rejecting (resolve/reject only borrow the handle for the call).
//   * A late settleOp() for an op torn down with its VM is a deliberate no-op: it never touches a
//     disposed VM and never logs an error.
//   * drainPendingJobs() is re-entrancy-guarded per VM (vmDrains): a settle that happens while a
//     drain is already pumping that VM must not start a second nested pump loop.
const MAX_JOBS_PER_SLICE = 1000;
// Wall-clock cap (ms) for draining a thenable `deactivate` result before disposal proceeds. A guest
// cleanup gets a bounded chance to run; a deactivate that never settles must never block disposal.
const DEACTIVATE_DRAIN_MS = 2000;
// opId -> { pluginId, vm, deferred, label } — in-flight host async ops awaiting settlement.
const pendingOps = new Map();
// vm -> { draining: true } — re-entrancy guard, true only while a drain is pumping this VM.
const vmDrains = new WeakMap();
let nextOpId = 1;
// Per-renderer-instance sequence for window-controls ownership tokens.
// Each buildWindowControlsApi call mints one unique instanceKey; owners are
// keyed by instanceKey (never bare pluginId) so a revoked instance's late
// continuations can never touch a newer generation's registration.
let windowControlsInstanceSeq = 0;
// Test seam: number of drains that actually ran (guard passed). reset() clears it.
let pumpDrainCount = 0;

// Drain a VM's promise jobs until none remain (or a slice fails). Runs under runQuickJSOperation so
// guest continuations execute inside the same per-operation CPU-deadline enforcement as every other
// plugin turn (ADR 0002), and a failing slice stops the pump without spinning.
function drainPendingJobs(vm, pluginId, label) {
  if (vmSealed.has(vm) && !teardownActive.has(vm)) {
    // A3 isolation: a sealed VM (its window transferred) must not run guest jobs for any
    // async source except its owning teardown batch, which marks teardownActive first.
    return;
  }
  if (vmDrains.get(vm)) {
    // Already draining this VM (a settle happened from inside a guest job the current drain is
    // executing). The running pump loop re-checks hasPendingJob() and picks the new job up, so a
    // nested pump would only re-enter the same loop.
    return;
  }
  vmDrains.set(vm, { draining: true });
  pumpDrainCount += 1;
  try {
    while (vm.runtime.hasPendingJob()) {
      const ok = runQuickJSOperation(vm, pluginId, label, () => {
        const result = vm.runtime.executePendingJobs(MAX_JOBS_PER_SLICE);
        if (result.error) {
          // A job threw out of the engine: let runQuickJSOperation surface and dispose the error.
          return result;
        }
        // executePendingJobs reports success as a job *count*, but runQuickJSOperation expects a
        // disposable handle in result.value (it disposes the value after a clean run). Substitute
        // the VM's undefined — a static handle whose dispose() is a no-op — so that bookkeeping is
        // satisfied without inventing or leaking a real value.
        result.dispose();
        return { error: undefined, value: vm.undefined };
      });
      if (!ok) break;
    }
  } finally {
    vmDrains.delete(vm);
  }
}

// Settle a pending host op: resolve (mode "resolve") or reject (mode "reject") its deferred with the
// QuickJS handle produced by `makeHandle`, dispose the deferred, and drain so the guest continuation
// runs. Errors are logged via pluginLog and never thrown across the host boundary.
function settleOp(id, mode, makeHandle) {
  const op = pendingOps.get(id);
  if (!op) {
    // Already settled, or torn down with its VM (cleanupPendingOps). Late settles are no-ops.
    return;
  }
  if (vmSealed.has(op.vm)) {
    // A3 isolation: the owning window transferred. Teardown deleted this op's registration at
    // transfer (abandonVmOps); a surviving entry races teardown and must not touch the VM.
    return;
  }
  pendingOps.delete(id);
  const label = op.label + " (op #" + id + ")";
  try {
    const value = makeHandle();
    try {
      if (mode === "reject") {
        op.deferred.reject(value);
      } else {
        op.deferred.resolve(value);
      }
    } finally {
      // makeHandle produced an owned handle; resolve/reject only borrowed it for the call.
      if (value && typeof value.dispose === "function") {
        try {
          value.dispose();
        } catch (_e) {
          // Best effort — settlement already happened.
        }
      }
    }
    op.deferred.dispose();
    drainPendingJobs(op.vm, op.pluginId, label + " drain");
  } catch (e) {
    pluginLog(op.pluginId, "error", label + " settle failed: " + errorText(e));
  }
}

// Create a host-owned pending promise for an async host API. The returned handle is the promise the
// guest `await`s (return it from the host function); settle it later via settleOp(opId, ...).
function newHostPromise(vm, pluginId, label) {
  if (vmSealed.has(vm)) {
    // A3 isolation: sealed VMs must not create new pending ops. Return the VM's undefined as
    // the awaited value so guest continuations observe no settlement and run no further.
    return { opId: -1, handle: vm.undefined };
  }
  const deferred = vm.newPromise();
  const opId = nextOpId++;
  pendingOps.set(opId, { pluginId, vm, deferred, label: label || "host op" });
  return { opId, handle: deferred.handle };
}

// Dispose every pending op that belongs to `vm` and drop the VM's drain guard. Runs inside
// disposeVM() so a VM parked on an unresolved host op is disposed without leaking its deferred's
// QuickJS handles — and so a late settleOp for it can never touch the disposed VM.
function cleanupPendingOps(vm) {
  for (const [id, op] of pendingOps) {
    if (op.vm === vm) {
      pendingOps.delete(id);
      try {
        op.deferred.dispose();
      } catch (_e) {
        // Best effort — the VM is going away regardless.
      }
    }
  }
  vmDrains.delete(vm);
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
  if (vmSealed.has(vm) && !teardownActive.has(vm)) {
    // A3 isolation: sealed VMs run no further guest code except inside their teardown batch.
    return false;
  }
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

// --- Async lifecycle (activate/deactivate may return a Promise; ADR 0008) ---
//
// The synchronous-void contract ("return undefined") still holds for lifecycle-*event* callbacks
// (onCreated/onLoad/onRendererReady/onUnload/dom.observe — those call sites keep requireUndefined
// unmodified). Only the module lifecycle hooks activate/deactivate may instead return a Promise
// that the host drains. The helpers below implement that relaxation on top of the pump.

// True when a QuickJS value has a callable `then` — the shape an async activate/deactivate returns.
// The handle is borrowed; nothing is disposed.
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

// Best-effort guest error text for logging: prefer the `message` property (a plain string read that
// runs no guest code), then fall back to a JSON dump.
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

// Invoke a plugin lifecycle hook (activate/deactivate) under the CPU deadline. Returns false when
// the call itself failed (threw, returned a QuickJS error, or — keeping the synchronous-void
// contract — returned a non-undefined, non-thenable value). On success returns true; if the hook
// returned a thenable, ownership of its promise handle is transferred into `capture.asyncResult`
// (the caller disposes it) and the hook is presented to runQuickJSOperation as void-returning so
// the shared requireUndefined enforcement does not reject it — the caller drains the continuation
// instead. Every other call site's requireUndefined semantics are untouched.
function runLifecycleHook(vm, pluginId, label, invoke, capture) {
  return runQuickJSOperation(vm, pluginId, label, () => {
    const result = invoke();
    if (result.error) return result;
    if (isThenableResult(vm, result.value)) {
      capture.asyncResult = result.value;
      return { error: undefined, value: vm.undefined };
    }
    return result;
  }, true);
}

// Watch a pending async `activate` result on an already-registered plugin. Fulfillment is a no-op
// (registration already happened); a rejection fails the plugin closed through `onRejected`, exactly
// like a synchronous activate failure. Ownership of `thenableHandle` transfers here and it is
// disposed once the guest promise has been assimilated (the guest keeps it alive through its own
// reactions). Drains once so guest microtasks start moving.
function watchAsyncActivate(vm, pluginId, label, thenableHandle, onRejected) {
  const native = vm.resolvePromise(thenableHandle);
  thenableHandle.dispose();
  native.then(
    (result) => {
      if (vmSealed.has(vm)) {
        // A3 isolation: the window transferred while activation was in flight. The close batch
        // owns this VM's disposal; this late settlement must not touch it (dispose here would
        // double-count disposal and could run guest-adjacent cleanup twice).
        try {
          if (result && typeof result.dispose === "function") result.dispose();
          else if (result && result.error) result.error.dispose();
        } catch (_e) {
          // Best effort.
        }
        return;
      }
      if (result && result.error) {
        const reason = guestErrorText(vm, result.error);
        try {
          result.dispose(); // disposes the dup'd error handle
        } catch (_e) {
          // Best effort.
        }
        onRejected(reason);
      } else if (result && typeof result.dispose === "function") {
        try {
          result.dispose(); // disposes the dup'd resolved-value handle
        } catch (_e) {
          // Best effort.
        }
      }
    },
    (error) => {
      // resolvePromise resolves (never rejects) natively; this branch is defensive only. A3
      // isolation: a sealed window's late settlement returns here without touching its VM —
      // the close batch owns disposal.
      if (vmSealed.has(vm)) return;
      onRejected(error && error.message ? String(error.message) : String(error));
    },
  );
  drainPendingJobs(vm, pluginId, label);
}

// Drain a thenable `deactivate` result until it settles or `timeoutMs` elapses, so an async guest
// cleanup gets a chance to run before the VM is disposed — bounded so disposal is never blocked
// forever. Returns "fulfilled" / "rejected" / "timeout". Does not dispose `promiseHandle` (the
// caller owns it). Internal settlement-state handles are disposed here.
function drainThenableResult(vm, pluginId, label, promiseHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    drainPendingJobs(vm, pluginId, label);
    let state;
    try {
      state = vm.getPromiseState(promiseHandle);
    } catch (_e) {
      return "fulfilled"; // VM is going away; treat as settled so disposal proceeds.
    }
    if (state.type === "fulfilled") {
      if (!state.notAPromise && state.value) {
        try {
          state.value.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      return "fulfilled";
    }
    if (state.type === "rejected") {
      if (state.error) {
        try {
          state.error.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      return "rejected";
    }
    if (Date.now() >= deadline) return "timeout";
  }
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
  // A VM parked on an unresolved async host op must not leak its pending deferred's QuickJS
  // handles, and a late settleOp for one of those ops must become a no-op (see cleanupPendingOps).
  cleanupPendingOps(vm);
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

// Run the plugin's own module.exports.deactivate(ctx) while the VM is still alive, then run host
// cleanup and dispose the VM. deactivate may return undefined (the synchronous contract) or a
// Promise/thenable it awaits to completion (ADR 0008): a thenable result is drained — bounded by
// DEACTIVATE_DRAIN_MS — so an async guest cleanup runs before disposal, but a timeout/rejection
// never blocks disposal (fail-closed). A throwing or non-undefined synchronous result stays a
// failed cleanup, logged, and never blocks disposal. `cleanups` is the host-cleanup array (an empty
// array when the plugin had no renderer/main async observers to tear down; never null).
function deactivatePluginVM(vm, pluginId, label, lifecycle, cleanups) {
  if (lifecycle.deactivateExport) {
    const capture = { asyncResult: null };
    const ok = runLifecycleHook(
      vm,
      pluginId,
      label + " deactivate",
      () => vm.callFunction(lifecycle.deactivateExport, lifecycle.moduleExports, lifecycle.ctx),
      capture,
    );
    if (!ok) {
      if (capture.asyncResult) {
        try {
          capture.asyncResult.dispose(); // over-deadline edge: never reached the async path
        } catch (_e) {
          // Best effort.
        }
      }
      pluginLog(
        pluginId,
        "error",
        label + " deactivate failed or returned a non-undefined result; continuing with disposal",
      );
    } else if (capture.asyncResult) {
      const outcome = drainThenableResult(
        vm,
        pluginId,
        label + " deactivate",
        capture.asyncResult,
        DEACTIVATE_DRAIN_MS,
      );
      try {
        capture.asyncResult.dispose();
      } catch (_e) {
        // Best effort.
      }
      if (outcome !== "fulfilled") {
        pluginLog(
          pluginId,
          "error",
          label + " deactivate failed or timed out; continuing with disposal",
        );
      }
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

// Per-plugin config API (ctx.config), read synchronously from the merged config snapshot the Core
// execution plan carries for this plugin (schema defaults overlaid with stored values). configObj
// is a plain host-side object of scalar values; it is captured per-VM when the plugin loads, so a
// newer plan revision respawns the VM (via the fingerprint) with the new config.
//
// `set` is a NO-OP for sandboxed plugins: config is only persisted via the Manager control-plane
// RPCs (setPluginConfig); the runtime never writes config itself.
function buildConfigApi(vm, pluginId, configObj) {
  const config = vm.newObject();

  const get = vm.newFunction("get", (keyHandle) => {
    if (vm.typeof(keyHandle) !== "string") {
      // Non-string keys are rejected without coercing the handle (no guest code runs).
      return vm.undefined;
    }
    const key = vm.getString(keyHandle);
    if (!Object.prototype.hasOwnProperty.call(configObj, key)) {
      return vm.undefined;
    }
    const value = configObj[key];
    const valueType = typeof value;
    switch (valueType) {
      case "string":
        return vm.newString(value);
      case "number":
        return vm.newNumber(value);
      case "boolean":
        return value ? vm.true : vm.false;
      case "object":
        if (value === null) return vm.null;
        break;
      default:
        break;
    }
    // Defensive: merged config only ever contains schema-typed scalars, so a container/other value
    // would indicate a Core-side or state mismatch. Surface it instead of leaking host objects.
    pluginLog(
      pluginId,
      "warn",
      "config.get(" + key + "): unsupported value type (" + valueType + "); returning undefined",
    );
    return vm.undefined;
  });
  vm.setProp(config, "get", get);
  get.dispose();

  const set = vm.newFunction("set", () => vm.undefined);
  vm.setProp(config, "set", set);
  set.dispose();

  return config;
}

// Build a QuickJS handle for a JSON-safe JS value (string/number/boolean/null/object of these).
// Used to hand Core/host results to the guest. Arrays are not needed by the current surfaces
// (NetworkResponse.headers is an object, DomElement is an object). Each returned handle is owned by
// the caller (settleOp borrows + disposes it; the guest's deferred owns it after resolve).
function handlesFromJson(vm, value) {
  if (value === null || value === undefined) {
    return vm.null;
  }
  const kind = typeof value;
  if (kind === "string") {
    return vm.newString(value);
  }
  if (kind === "number") {
    return vm.newNumber(value);
  }
  if (kind === "boolean") {
    return value ? vm.true : vm.false;
  }
  if (kind === "object") {
    const obj = vm.newObject();
    for (const [key, item] of Object.entries(value)) {
      // Skip dangerous keys that could alter the new object's prototype/constructor semantics.
      // The values are page-controlled (e.g. DomElement attrs), so never let them become special.
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const itemHandle = handlesFromJson(vm, item);
      vm.setProp(obj, key, itemHandle);
      itemHandle.dispose();
    }
    return obj;
  }
  // Unknown scalar type (bigint/symbol/function): surface as undefined rather than leaking host.
  return vm.undefined;
}

// `ctx.network.request(req)` — async host function bridging to the Core `networkRequest` RPC, which
// performs the permissioned, domain-whitelisted fetch Core-side. Returns a QuickJS Promise the guest
// awaits; the value/rejection is delivered by the in-process pending-job pump (ADR 0008).
function buildNetworkApi(vm, pluginId) {
  const network = vm.newObject();

  const request = vm.newFunction("request", (reqHandle) => {
    if (vm.typeof(reqHandle) !== "object") {
      pluginLog(pluginId, "warn", "network.request: argument must be a request object");
      return vm.undefined;
    }
    // Read the request fields as data (coercion runs under the enclosing operation's deadline).
    const urlHandle = vm.getProp(reqHandle, "url");
    const url = vm.typeof(urlHandle) === "string" ? vm.getString(urlHandle) : "";
    urlHandle.dispose();
    const methodHandle = vm.getProp(reqHandle, "method");
    const method =
      vm.typeof(methodHandle) === "string" ? vm.getString(methodHandle).toUpperCase() : "GET";
    methodHandle.dispose();
    // headers: object of string->string; body: string (default "").
    const headers = {};
    const headersHandle = vm.getProp(reqHandle, "headers");
    if (vm.typeof(headersHandle) === "object") {
      for (const key of Object.keys(vm.dump(headersHandle) || {})) {
        if (typeof key !== "string") continue;
        const valHandle = vm.getProp(headersHandle, key);
        if (vm.typeof(valHandle) === "string") headers[key] = vm.getString(valHandle);
        valHandle.dispose();
      }
    }
    headersHandle.dispose();
    const bodyHandle = vm.getProp(reqHandle, "body");
    const body = vm.typeof(bodyHandle) === "string" ? vm.getString(bodyHandle) : "";
    bodyHandle.dispose();

    const { opId, handle } = newHostPromise(vm, pluginId, "network.request");
    planRequest("networkRequest", { pluginId, url, method, headers, body }, { timeout: 30000 })
      .then(({ id, envelope }) => {
        const result = validatePlanEnvelope(envelope, id);
        settleOp(opId, "resolve", () => handlesFromJson(vm, result));
      })
      .catch((e) => {
        settleOp(opId, "reject", () => vm.newString(errorText(e)));
      });
    return handle;
  });
  vm.setProp(network, "request", request);
  request.dispose();

  return network;
}

// Denied `ctx.network` stub — mounted whenever `network.access` is NOT granted so the required
// `ctx.network` surface (SDK PluginContext) is always present. `request()` never touches the
// transport; it returns a QuickJS Promise rejected with the same string shape as a real transport
// failure (`vm.newString`), so guest `try/catch` sees "network.access not granted" instead of a
// synchronous `undefined` TypeError. Never throws synchronously — always returns the promise.
const NETWORK_ACCESS_DENIED = "network.access not granted";
function buildNetworkDeniedApi(vm, pluginId) {
  const network = vm.newObject();
  const request = vm.newFunction("request", () => {
    const { opId, handle } = newHostPromise(vm, pluginId, "network.request");
    // Settle asynchronously to reuse the pending-job pump path (same as the real bridge).
    Promise.resolve().then(() => {
      settleOp(opId, "reject", () => vm.newString(NETWORK_ACCESS_DENIED));
    });
    return handle;
  });
  vm.setProp(network, "request", request);
  request.dispose();
  return network;
}

// `ctx.css` — renderer-only async host API bridging `webContents.insertCSS` (data, never JS).
// Requires the `renderer.css` grant. `insert(css)` injects via the host and resolves to the
// Electron CSS key; `remove(key)` revokes via removeCssKey (bounded retries, same path as the
// manifest-CSS reconcile). Each op is a QuickJS Promise delivered by the pump (ADR 0008).
function buildCssApi(vm, pluginId, w, cleanupCallbacks) {
  const contents = w.contents;
  const css = vm.newObject();
  const liveKeys = new Set();
  const insert = vm.newFunction("insert", (cssHandle) => {
    if (vm.typeof(cssHandle) !== "string") {
      pluginLog(pluginId, "warn", "css.insert: argument must be a CSS string");
      return vm.undefined;
    }
    const cssText = vm.getString(cssHandle);
    const { opId, handle } = newHostPromise(vm, pluginId, "css.insert");
    contents
      .insertCSS(cssText)
      .then((key) => {
        liveKeys.add(key);
        settleOp(opId, "resolve", () => vm.newString(key));
      })
      .catch((e) => settleOp(opId, "reject", () => vm.newString(errorText(e))));
    return handle;
  });
  vm.setProp(css, "insert", insert);
  insert.dispose();
  const remove = vm.newFunction("remove", (idHandle) => {
    if (vm.typeof(idHandle) !== "string") {
      pluginLog(pluginId, "warn", "css.remove: argument must be a CSS key string");
      return vm.undefined;
    }
    const key = vm.getString(idHandle);
    if (key === "") {
      pluginLog(pluginId, "warn", "css.remove: invalid key");
      return vm.undefined;
    }
    const { opId, handle } = newHostPromise(vm, pluginId, "css.remove");
    removeCssKey(w, pluginId, key).then((removed) => {
      if (removed) {
        liveKeys.delete(key);
        settleOp(opId, "resolve", () => vm.undefined);
      } else {
        settleOp(opId, "reject", () => vm.newString("CSS removal failed"));
      }
    });
    return handle;
  });
  vm.setProp(css, "remove", remove);
  remove.dispose();
  if (Array.isArray(cleanupCallbacks)) {
    cleanupCallbacks.push(() => {
      for (const key of [...liveKeys]) {
        liveKeys.delete(key);
        removeCssKey(w, pluginId, key).catch(() => {});
      }
    });
  }
  return css;
}

// `ctx.windowControls` — renderer-only declarative traffic-light overlay
// (requires `electron.windowControls`). The plugin may only `mount()` /
// `unmount()` a fixed-style cluster; the host renders the buttons in an
// INDEPENDENT trusted WebContentsView (separate WebContents, safe
// webPreferences, data-URL HTML, no <script>, no preload) and binds real user
// clicks to the CURRENT BrowserWindow via interception on the OVERLAY view
// only (registration-source boundary plus per-window-token-verified; the
// `will-navigate` listener additionally requires event.sender to be exactly
// the overlay WebContents): the overlay links carry
// `target="_blank"`, so every click arrives at the overlay view's
// `setWindowOpenHandler` (verified, then always denied — the overlay never
// opens windows nor leaves its trusted document), with `will-navigate` /
// `will-frame-navigate` interception as the fallback path on builds that
// navigate custom-scheme link clicks instead. Rationale: on newer Electron,
// custom-scheme clicks from a `data:` document emit NO navigation event at
// all (observed on 43: no will-*, no did-start-navigation), which left the
// lights visible but dead under navigation-only interception. A twin-dedup
// (same action sighted through another path within a short window is
// skipped) keeps one click to one op. The target
// page's WebContents is never injected and never listened on for window
// actions: page forgeries (`ipc-message`, forged navigations, DOM events)
// cannot reach window ops. No window handle is accepted (extra args warn +
// return `undefined`), no generic DOM is exposed, and there is no
// single-close primitive. Each op is a QuickJS Promise delivered by the pump
// (ADR 0008). Fail-closed: without a live BrowserWindow or a trusted view,
// `mount()` rejects and registers no owner. Not an ADAPTERS adapter;
// `wco.js` behavior unchanged.
//
// Ownership: per-window `owners` is a Map keyed by per-instance unique token
// (never bare pluginId), plus per-instance `revoked` / `desiredMounted` /
// `operationGeneration`. The shared view slot is `idle` / `loading` / `ready`:
// concurrent mounts join the single in-flight load (one view, one load
// promise, every waiter settled by it); only load success registers owners,
// load failure rejects every waiter and clears view + listeners + token.
// Every construction bumps `resourceGeneration` and captures its own
// view/overlayContents/token; a superseded settle destroys only its own
// capture and routes live waiters onto the current slot — never current host
// fields. The last owner leaving removes the view and all listeners together.
function buildWindowControlsApi(vm, pluginId, w, cleanupCallbacks) {
  const contents = w.contents;
  if (!w.windowControlsHost) {
    w.windowControlsHost = {
      owners: new Map(),
      view: null,
      overlayContents: null,
      token: null,
      addedToWin: null,
      willNavigateListener: null,
      // `will-frame-navigate` twin of the above (fallback path on builds that
      // navigate custom-scheme link clicks). Both listeners share one
      // validator + a twin-dedup so a single click dispatches at most once.
      willFrameNavigateListener: null,
      // Primary click path: per-view `setWindowOpenHandler` (overlay links
      // carry `target="_blank"`). Dies with the contents on teardown.
      windowOpenHandler: null,
      // Last dispatched overlay action + sighting path + timestamp for the
      // twin-dedup above.
      lastNavDispatch: null,
      win: null,
      maximizeListener: null,
      unmaximizeListener: null,
      installed: false,
      // Shared-load slot: idle (no view) | loading (one loadURL in flight,
      // concurrent mounts join it) | ready (view usable, refcounted reuse).
      loadState: "idle",
      loadPromise: null,
      // Current construction's captured resources + waiter list. Every
      // construction bumps resourceGeneration; late settles whose generation
      // no longer matches are stale and may only destroy their OWN captured
      // view — never current host fields.
      loadRes: null,
      resourceGeneration: 0,
    };
  }
  const host = w.windowControlsHost;
  const owners = host.owners;

  windowControlsInstanceSeq += 1;
  const instanceKey = pluginId + "#" + windowControlsInstanceSeq + "@" + contents.id;
  let revoked = false;
  let desiredMounted = false;
  let operationGeneration = 0;

  function currentBrowserWindow() {
    try {
      const live = liveBrowserWindowForContentsId(contents.id);
      if (live) return live;
    } catch (_e) {
      // Fall through to null.
    }
    return null;
  }

  function getElectronModule() {
    try {
      return require("electron");
    } catch (_e) {
      return null;
    }
  }

  function syncOverlay() {
    try {
      const oc = host.overlayContents;
      if (!oc || typeof oc.executeJavaScript !== "function") return;
      if (typeof oc.isDestroyed === "function" && oc.isDestroyed()) return;
      const win = currentBrowserWindow();
      const maximized =
        win && typeof win.isMaximized === "function" ? !!win.isMaximized() : false;
      oc.executeJavaScript(windowControls.windowControlsSyncSnippet(maximized)).catch(() => {});
    } catch (_e) {
      // Best effort — sync must never throw across the bridge.
    }
  }

  function detachViewFromWindow(view, win) {
    if (!view || !win) return;
    try {
      if (win.contentView && typeof win.contentView.removeChildView === "function") {
        win.contentView.removeChildView(view);
        return;
      }
    } catch (_e) {
      // Fall through to legacy seam.
    }
    try {
      if (typeof win.removeBrowserView === "function") win.removeBrowserView(view);
    } catch (_e) {
      // Best effort.
    }
  }

  // Best-effort teardown of EXPLICITLY captured view resources. Operates on
  // the passed references only — never on live host fields — so a stale load
  // settle can destroy exactly the view it built without touching a newer
  // generation. Never throws.
  function destroyViewResources(res) {
    if (!res) return;
    try {
      if (res.willNavigateListener && res.overlayContents) {
        const oc = res.overlayContents;
        try {
          if (typeof oc.removeListener === "function")
            oc.removeListener("will-navigate", res.willNavigateListener);
          else if (typeof oc.off === "function")
            oc.off("will-navigate", res.willNavigateListener);
        } catch (_e) {
          // Best effort.
        }
      }
    } catch (_e) {
      // Best effort.
    }
    try {
      if (res.willFrameNavigateListener && res.overlayContents) {
        const oc = res.overlayContents;
        try {
          if (typeof oc.removeListener === "function")
            oc.removeListener("will-frame-navigate", res.willFrameNavigateListener);
          else if (typeof oc.off === "function")
            oc.off("will-frame-navigate", res.willFrameNavigateListener);
        } catch (_e) {
          // Best effort.
        }
      }
    } catch (_e) {
      // Best effort.
    }
    try {
      if (res.win && typeof res.win.removeListener === "function") {
        if (res.maximizeListener) res.win.removeListener("maximize", res.maximizeListener);
        if (res.unmaximizeListener)
          res.win.removeListener("unmaximize", res.unmaximizeListener);
      }
    } catch (_e) {
      // Best effort.
    }
    try {
      if (res.view) {
        if (res.addedToWin) detachViewFromWindow(res.view, res.addedToWin);
        const live = currentBrowserWindow();
        if (live && live !== res.addedToWin) detachViewFromWindow(res.view, live);
      }
    } catch (_e) {
      // Best effort.
    }
    try {
      const oc = res.overlayContents;
      if (oc) {
        // Unregister the host-internal surface on every teardown path.
        try {
          internalOverlayContents.delete(oc);
        } catch (_e) {
          // Best effort.
        }
        let dead = false;
        try {
          dead = typeof oc.isDestroyed === "function" ? !!oc.isDestroyed() : false;
        } catch (_e) {
          dead = true;
        }
        if (!dead) {
          if (typeof oc.close === "function") oc.close();
          else if (typeof oc.destroy === "function") oc.destroy();
        }
      }
    } catch (_e) {
      // Best effort.
    }
    // Partial constructions (unusable/missing webContents): destroy the view
    // shell itself when it exposes a closer. Never throws.
    try {
      const v = res.view;
      if (v && (!res.overlayContents || v.webContents !== res.overlayContents)) {
        if (typeof v.close === "function") v.close();
        else if (typeof v.destroy === "function") v.destroy();
      }
    } catch (_e) {
      // Best effort.
    }
  }

  function isWaiterValid(waiter) {
    try {
      return !!waiter.isValid();
    } catch (_e) {
      return false;
    }
  }

  function hasValidLoadWaiters() {
    return !!(
      host.loadState === "loading" &&
      host.loadRes &&
      Array.isArray(host.loadRes.waiters) &&
      host.loadRes.waiters.some(isWaiterValid)
    );
  }

  function isCapturedDestroyed(res) {
    try {
      const oc = res && res.overlayContents;
      return !!oc && typeof oc.isDestroyed === "function" && !!oc.isDestroyed();
    } catch (_e) {
      return true;
    }
  }

  // Full teardown of the CURRENT host slot: snapshot current resources, clear
  // host fields first (bumping the generation orphans any in-flight settle),
  // then destroy the snapshot. In-flight settles arriving late observe the
  // generation mismatch and fall into the stale path (own-view-only destroy).
  function uninstallHost() {
    const res = {
      view: host.view,
      overlayContents: host.overlayContents,
      willNavigateListener: host.willNavigateListener,
      willFrameNavigateListener: host.willFrameNavigateListener,
      win: host.win,
      maximizeListener: host.maximizeListener,
      unmaximizeListener: host.unmaximizeListener,
      addedToWin: host.addedToWin,
    };
    host.view = null;
    host.overlayContents = null;
    host.token = null;
    host.addedToWin = null;
    host.willNavigateListener = null;
    host.willFrameNavigateListener = null;
    host.windowOpenHandler = null;
    host.lastNavDispatch = null;
    host.win = null;
    host.maximizeListener = null;
    host.unmaximizeListener = null;
    host.installed = false;
    host.loadState = "idle";
    host.loadPromise = null;
    host.loadRes = null;
    host.resourceGeneration += 1;
    destroyViewResources(res);
  }

  // Ready only after the shared loadURL resolves. A view still loading (or a
  // leftover from a torn-down generation) is never reused as healthy.
  function overlayViewHealthy() {
    if (host.loadState !== "ready") return false;
    if (!host.installed || !host.view || !host.overlayContents || !host.token) return false;
    try {
      const oc = host.overlayContents;
      if (typeof oc.isDestroyed === "function" && oc.isDestroyed()) return false;
    } catch (_e) {
      return false;
    }
    return true;
  }

  // Settle the shared load owned by `res`. Attached once per construction;
  // concurrent mounts join via res.waiters and are all settled here.
  function settleSharedLoadSuccess(res) {
    if (host.loadRes !== res || host.resourceGeneration !== res.generation || host.loadState !== "loading") {
      settleStaleLoad(res, null);
      return;
    }
    if (w.dead || windows.get(contents.id) !== w || contentsDestroyed(w) || isCapturedDestroyed(res)) {
      failCurrentLoad(res, "window destroyed");
      return;
    }
    host.loadState = "ready";
    host.loadPromise = null;
    syncOverlay();
    const waiters = Array.isArray(res.waiters) ? res.waiters : [];
    res.waiters = [];
    for (const waiter of waiters) {
      // Only load success registers an owner — and only for still-valid
      // waiters. Superseded waiters resolve harmlessly (their VMs are gone or
      // detached; settleOp no-ops on missing ops).
      if (isWaiterValid(waiter)) owners.set(waiter.myKey, waiter.pluginId);
      try {
        waiter.resolve();
      } catch (_e) {
        // Best effort — one bad waiter must not starve the rest.
      }
    }
    // Nobody claimed the view (every waiter revoked/unmounted mid-load):
    // tear it down so no ownerless overlay lingers.
    if (owners.size === 0) {
      uninstallHost();
    }
  }

  function settleSharedLoadFailure(res, e) {
    if (host.loadRes !== res || host.resourceGeneration !== res.generation) {
      settleStaleLoad(res, errorText(e));
      return;
    }
    failCurrentLoad(res, errorText(e));
  }

  // Current-slot load failure (or window death mid-load): reject every valid
  // waiter, resolve the superseded ones harmlessly, and clear the whole slot
  // (view + listeners + token) so a retry starts clean.
  function failCurrentLoad(res, reason) {
    const waiters = Array.isArray(res.waiters) ? res.waiters : [];
    res.waiters = [];
    if (host.loadRes === res) {
      uninstallHost();
    } else {
      destroyViewResources(res);
    }
    for (const waiter of waiters) {
      try {
        if (isWaiterValid(waiter)) waiter.reject(reason);
        else waiter.resolve();
      } catch (_e) {
        // Best effort.
      }
    }
  }

  // A superseded construction settled late. Destroy ONLY our own captured
  // view; route still-valid waiters onto the live slot (adopt into the
  // current load, or register on the current ready view); superseded waiters
  // resolve harmlessly. Never touches current host fields.
  function settleStaleLoad(res, failureReason) {
    const waiters = Array.isArray(res.waiters) ? res.waiters : [];
    res.waiters = [];
    for (const waiter of waiters) {
      if (!isWaiterValid(waiter)) {
        try {
          waiter.resolve();
        } catch (_e) {
          // Best effort.
        }
        continue;
      }
      if (
        host.loadState === "loading" &&
        host.loadRes &&
        host.loadRes !== res &&
        Array.isArray(host.loadRes.waiters)
      ) {
        host.loadRes.waiters.push(waiter);
        continue;
      }
      if (!failureReason && host.loadState === "ready" && overlayViewHealthy()) {
        owners.set(waiter.myKey, waiter.pluginId);
        try {
          waiter.resolve();
        } catch (_e) {
          // Best effort.
        }
        continue;
      }
      try {
        waiter.reject(failureReason || "superseded");
      } catch (_e) {
        // Best effort.
      }
    }
    destroyViewResources(res);
  }

  // Build the trusted overlay view synchronously up to loadURL, claim the
  // shared loading slot (host.loadRes + loadPromise), and attach the shared
  // settle exactly once. Every attempt bumps resourceGeneration and captures
  // its own view/overlayContents/token; late settles of superseded attempts
  // destroy only their own capture. On any construction failure all partial
  // resources are destroyed and no host residue remains (fail-closed,
  // registers no owner, rejects the caller).
  function constructTrustedView(win) {
    const Electron = getElectronModule();
    const ViewCtor = (Electron && Electron.WebContentsView) || null;
    if (!ViewCtor) return { ok: false, reason: "no trusted view constructor" };
    if (!win) return { ok: false, reason: "no live window" };
    const generation = ++host.resourceGeneration;
    let token = null;
    try {
      token = windowControls.generateWindowControlsToken();
    } catch (e) {
      return { ok: false, reason: "token failure: " + errorText(e) };
    }
    // Claim the loading slot up front so concurrent mounts join this exact
    // load instead of building a second view.
    host.token = token;
    host.loadState = "loading";
    const partial = {
      view: null,
      overlayContents: null,
      willNavigateListener: null,
      willFrameNavigateListener: null,
      // Single-slot window-open handler (no removal API; dies with the
      // contents, which every teardown path destroys).
      windowOpenHandler: null,
      win,
      maximizeListener: null,
      unmaximizeListener: null,
      addedToWin: null,
    };
    const fail = (reason) => {
      destroyViewResources(partial);
      if (host.resourceGeneration === generation && host.loadState === "loading" && host.token === token) {
        host.token = null;
        host.loadState = "idle";
      }
      return { ok: false, reason };
    };
    // Synchronous internal-construction guard: the platform may fire
    // `web-contents-created` re-entrantly inside `new ViewCtor()`, before the
    // fresh WebContents can be registered below. The global handler excludes
    // everything created under this guard first (try/finally: always balanced).
    internalOverlayConstructionDepth += 1;
    try {
      partial.view = new ViewCtor({
        webPreferences: { ...windowControls.WINDOW_CONTROLS_SAFE_PREFERENCES },
      });
    } catch (e) {
      return fail("view construct failed: " + errorText(e));
    } finally {
      internalOverlayConstructionDepth -= 1;
    }
    const overlayContents = partial.view && partial.view.webContents;
    if (!overlayContents || typeof overlayContents.on !== "function") {
      return fail("no overlay webContents");
    }
    partial.overlayContents = overlayContents;
    // Register the overlay surface as host-internal from here on: later
    // `web-contents-created` emissions for it never enter target discovery.
    // destroyViewResources unregisters on every teardown path.
    internalOverlayContents.add(overlayContents);
    try {
      if (win.contentView && typeof win.contentView.addChildView === "function") {
        win.contentView.addChildView(partial.view);
        partial.addedToWin = win;
      } else {
        return fail("no contentView seam");
      }
    } catch (e) {
      partial.addedToWin = null;
      return fail("addChildView failed: " + errorText(e));
    }
    try {
      if (typeof partial.view.setBounds === "function")
        partial.view.setBounds({ ...windowControls.WINDOW_CONTROLS_VIEW_BOUNDS });
    } catch (_e) {
      // Cosmetic only — a mispositioned but functional overlay stays secure.
      pluginLog(pluginId, "warn", "windowControls: setBounds failed; overlay may be mispositioned");
    }
    // Explicit transparent view background where supported, so no opaque
    // letterboxing surrounds the content-sized overlay. Cosmetic only.
    try {
      if (typeof partial.view.setBackgroundColor === "function")
        partial.view.setBackgroundColor("#00000000");
    } catch (_e) {
      // Best effort.
    }
    const capturedContents = overlayContents;
    const capturedToken = token;
    // Shared validator + dispatcher for all interception paths (navigation
    // events + window-open). Each listener blocks/denies FIRST (overlay never
    // leaves its trusted data-URL document), then path-appropriate
    // origin/URL/token/action checks run. Twin-dedup: one click can surface
    // through several paths; the second sighting (same action, other path,
    // within a short window) is skipped so one click dispatches at most
    // once — while repeats through the SAME path always dispatch (rapid
    // maximize-then-restore stays live).
    const dispatchOverlayNavigation = (seenVia, url) => {
      const parsed = windowControls.parseWindowControlsNavigation(url);
      if (!parsed) return;
      if (parsed.token !== capturedToken) {
        pluginLog(pluginId, "warn", "windowControls: rejected navigation with bad token");
        return;
      }
      const now = Date.now();
      const last = host.lastNavDispatch;
      if (
        last &&
        last.action === parsed.action &&
        last.seenVia !== seenVia &&
        now - last.at < 500
      )
        return;
      host.lastNavDispatch = { action: parsed.action, seenVia, at: now };
      const targetWin = currentBrowserWindow();
      if (!targetWin) {
        pluginLog(pluginId, "warn", "windowControls: no live window for action " + parsed.action);
        return;
      }
      let ok = false;
      try {
        ok = windowControls.applyWindowControlsAction(targetWin, parsed.action);
      } catch (_e) {
        ok = false;
      }
      if (ok) {
        pluginLog(pluginId, "info", "windowControls: action " + parsed.action);
        syncOverlay();
      } else {
        pluginLog(pluginId, "warn", "windowControls: action failed " + parsed.action);
      }
    };
    const blockFirst = (event) => {
      try {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
      } catch (_e) {
        // Best effort.
      }
    };
    const onWillNavigate = (event, url) => {
      // Strict fail-closed sender check: only a real event whose sender is
      // exactly the captured overlay WebContents can reach window ops. A
      // missing event/sender or a foreign sender (page, other view) is
      // ignored without side effects.
      if (!event || event.sender !== capturedContents) return;
      // Block the navigation FIRST: the overlay must never leave its trusted
      // data-URL document, even for URLs rejected below.
      blockFirst(event);
      dispatchOverlayNavigation("will-navigate", url);
    };
    // `will-frame-navigate` twin: same overlay-only interception for builds
    // that navigate custom-scheme link clicks instead of windowing them.
    // Real shape is a SINGLE param (Event<WebContentsWillFrameNavigateEventParams>:
    // url/isMainFrame/frame, no sender — see electron.d.ts): the source
    // boundary is that this listener is registered ONLY on the captured
    // overlay WebContents, so any invocation originates from it. Block FIRST
    // per the real details structure, then check frame role, URL, token.
    // The overlay document has no subframes by construction; a non-main-frame
    // navigation is blocked but never dispatched.
    const onWillFrameNavigate = (details) => {
      if (!details) return;
      blockFirst(details);
      if (details.isMainFrame === false) return;
      const url = typeof details.url === "string" ? details.url : "";
      dispatchOverlayNavigation("will-frame-navigate", url);
    };
    partial.willNavigateListener = onWillNavigate;
    partial.willFrameNavigateListener = onWillFrameNavigate;
    try {
      overlayContents.on("will-navigate", onWillNavigate);
    } catch (e) {
      return fail("will-navigate install failed: " + errorText(e));
    }
    try {
      // Best effort on old Electron without this event: `.on` with an unknown
      // name never fires and never throws; the `will-navigate` listener above
      // remains the dispatch path there.
      overlayContents.on("will-frame-navigate", onWillFrameNavigate);
    } catch (e) {
      partial.willFrameNavigateListener = null;
      pluginLog(pluginId, "warn", "windowControls: will-frame-navigate install failed: " + errorText(e));
    }
    // Primary click path: the overlay links carry `target="_blank"`, so every
    // click arrives here as a window-open request — including on builds where
    // custom-scheme clicks from a `data:` document emit no navigation event
    // at all (observed on Electron 43). Verified with the same token check,
    // then ALWAYS denied: the overlay never opens windows and never leaves
    // its trusted document. Overlay-only (registered on this WebContents, so
    // the page can never reach it); best effort when the API is absent.
    const onWindowOpen = (details) => {
      try {
        const url = details && typeof details.url === "string" ? details.url : "";
        dispatchOverlayNavigation("window-open", url);
      } catch (_e) {
        // Dispatch never throws, but deny unconditionally regardless.
      }
      return { action: "deny" };
    };
    partial.windowOpenHandler = null;
    try {
      if (typeof overlayContents.setWindowOpenHandler === "function") {
        overlayContents.setWindowOpenHandler(onWindowOpen);
        partial.windowOpenHandler = onWindowOpen;
      }
    } catch (e) {
      partial.windowOpenHandler = null;
      pluginLog(pluginId, "warn", "windowControls: window-open install failed: " + errorText(e));
    }
    // Maximize/unmaximize sync is cosmetic: install best-effort, never fail
    // the mount for it. Stored refs let every fail path remove partial installs.
    partial.maximizeListener = () => syncOverlay();
    partial.unmaximizeListener = () => syncOverlay();
    try {
      if (typeof win.on === "function") win.on("maximize", partial.maximizeListener);
    } catch (_e) {
      partial.maximizeListener = null;
    }
    try {
      if (typeof win.on === "function") win.on("unmaximize", partial.unmaximizeListener);
    } catch (_e) {
      partial.unmaximizeListener = null;
    }
    let loadP = null;
    try {
      loadP = overlayContents.loadURL(windowControls.windowControlsViewDataUrl(token));
    } catch (e) {
      return fail("overlay load threw: " + errorText(e));
    }
    if (!loadP || typeof loadP.then !== "function") {
      return fail("overlay load unavailable");
    }
    // Publish the construction and attach the shared settle exactly once.
    const res = {
      generation,
      view: partial.view,
      overlayContents,
      token,
      addedToWin: partial.addedToWin,
      willNavigateListener: onWillNavigate,
      willFrameNavigateListener: partial.willFrameNavigateListener,
      windowOpenHandler: partial.windowOpenHandler,
      win,
      maximizeListener: partial.maximizeListener,
      unmaximizeListener: partial.unmaximizeListener,
      waiters: [],
    };
    host.view = partial.view;
    host.overlayContents = overlayContents;
    host.addedToWin = partial.addedToWin;
    host.willNavigateListener = onWillNavigate;
    host.willFrameNavigateListener = partial.willFrameNavigateListener;
    host.windowOpenHandler = partial.windowOpenHandler;
    host.win = win;
    host.maximizeListener = partial.maximizeListener;
    host.unmaximizeListener = partial.unmaximizeListener;
    host.installed = true;
    host.loadRes = res;
    host.loadPromise = Promise.resolve(loadP);
    host.loadPromise.then(
      () => settleSharedLoadSuccess(res),
      (e) => settleSharedLoadFailure(res, e),
    );
    return { ok: true, loadP: host.loadPromise, res };
  }

  const api = vm.newObject();

  const mount = vm.newFunction("mount", (...mountArgs) => {
    if (mountArgs.length > 0) {
      pluginLog(
        pluginId,
        "warn",
        "windowControls.mount: takes no arguments (declarative overlay)",
      );
      return vm.undefined;
    }
    desiredMounted = true;
    const myOp = ++operationGeneration;
    const myKey = instanceKey;
    const myVm = vm;
    const { opId, handle } = newHostPromise(vm, pluginId, "windowControls.mount");
    // Each waiter carries its own VM's settle closures (handles must come
    // from the owning VM) plus a validity predicate over this instance's
    // revoked/desiredMounted/generation and window liveness. The shared load
    // settle calls them; no waiter is ever dropped silently.
    const waiter = {
      myKey,
      pluginId,
      isValid: () =>
        !revoked &&
        desiredMounted &&
        myOp === operationGeneration &&
        !w.dead &&
        windows.get(contents.id) === w &&
        !contentsDestroyed(w),
      resolve: () => settleOp(opId, "resolve", () => myVm.undefined),
      reject: (reason) => settleOp(opId, "reject", () => myVm.newString(reason || "overlay unavailable")),
    };
    if (revoked) {
      Promise.resolve().then(() => waiter.reject("revoked"));
      return handle;
    }
    if (owners.has(myKey)) {
      Promise.resolve().then(() => waiter.resolve());
      return handle;
    }
    if (contentsDestroyed(w) || w.dead || windows.get(contents.id) !== w) {
      Promise.resolve().then(() => waiter.reject("window destroyed"));
      return handle;
    }
    const win = currentBrowserWindow();
    if (!win) {
      Promise.resolve().then(() => waiter.reject("no live window for overlay"));
      return handle;
    }
    // Join an in-flight load: one view, one load promise, every concurrent
    // mount waits on it. Nobody registers an owner before load success.
    if (host.loadState === "loading" && host.loadRes && host.loadPromise) {
      host.loadRes.waiters.push(waiter);
      return handle;
    }
    // Reuse a healthy READY view (refcounted; load already succeeded).
    if (host.loadState === "ready" && overlayViewHealthy()) {
      owners.set(myKey, pluginId);
      syncOverlay();
      Promise.resolve().then(() => {
        if (!isWaiterValid(waiter)) {
          // Superseded between call and settle: undo self, keep settle harmless.
          owners.delete(myKey);
          if (owners.size === 0) {
            uninstallHost();
          }
        }
        waiter.resolve();
      });
      return handle;
    }
    // Idle (or unusable leftover): drop remnants so the build starts clean,
    // then construct a fresh trusted view. Only `mounted` (load success)
    // registers an owner — a `failed` load rejects every waiter and clears
    // view + listeners + token (fail-closed).
    uninstallHost();
    const built = constructTrustedView(win);
    if (!built.ok) {
      Promise.resolve().then(() => waiter.reject(built.reason || "overlay unavailable"));
      return handle;
    }
    built.res.waiters.push(waiter);
    return handle;
  });
  vm.setProp(api, "mount", mount);
  mount.dispose();

  const unmount = vm.newFunction("unmount", (...unmountArgs) => {
    if (unmountArgs.length > 0) {
      pluginLog(
        pluginId,
        "warn",
        "windowControls.unmount: takes no arguments (declarative overlay)",
      );
      return vm.undefined;
    }
    desiredMounted = false;
    operationGeneration += 1;
    const myKey = instanceKey;
    owners.delete(myKey);
    // Stale unmounts delete only their own key: newer generations use
    // different instanceKeys and are never touched here.
    const { opId, handle } = newHostPromise(vm, pluginId, "windowControls.unmount");
    const done = () => settleOp(opId, "resolve", () => vm.undefined);
    if (owners.size > 0) {
      Promise.resolve().then(done);
      return handle;
    }
    // Last owner leaving removes the view and all listeners together —
    // unless a load is in flight with other still-valid waiters, which own
    // it now (their settle tears it down when nobody claims it).
    if (!hasValidLoadWaiters()) {
      uninstallHost();
    }
    Promise.resolve().then(done);
    return handle;
  });
  vm.setProp(api, "unmount", unmount);
  unmount.dispose();

  if (Array.isArray(cleanupCallbacks)) {
    cleanupCallbacks.push(() => {
      try {
        revoked = true;
        desiredMounted = false;
        operationGeneration += 1;
        owners.delete(instanceKey);
        // Revocation during a shared load must not kill a view other live
        // instances are still waiting on: only tear down when no valid
        // waiter remains (the shared settle then owns the outcome).
        if (owners.size === 0 && !hasValidLoadWaiters()) {
          uninstallHost();
        }
      } catch (_e) {
        // A throwing host cleanup must not prevent VM disposal.
      }
    });
  }

  return api;
}

// `ctx.storage` — renderer-only async host API bridging the target page's localStorage, with a
// host-owned namespaced key (`tronhawk:<pluginId>:<key>`, pluginId is NEVER guest-supplied) so one
// plugin cannot read another's keys. Each get/set is a QuickJS Promise delivered by the pump; the
// page access is done via a host-owned, fixed `executeJavaScript` template that treats the key/value
// as data (JSON-stringified). Requires the `renderer.storage` grant.
function buildStorageApi(vm, pluginId, contents) {
  const storage = vm.newObject();
  const STORAGE_PREFIX = "tronhawk:" + pluginId + ":";

  function storageSnippet(body) {
    const prefix = JSON.stringify(STORAGE_PREFIX);
    return `((function(){var p=${prefix};try{${body}}catch(e){return null}})())`;
  }

  const get = vm.newFunction("get", (keyHandle) => {
    const key = vm.typeof(keyHandle) === "string" ? vm.getString(keyHandle) : "";
    if (key === "") {
      pluginLog(pluginId, "warn", "storage.get: invalid key");
      return vm.undefined;
    }
    const { opId, handle } = newHostPromise(vm, pluginId, "storage.get");
    const code = storageSnippet(
      `var v=localStorage.getItem(p+${JSON.stringify(key)});return v===null?null:JSON.parse(v)`,
    );
    contents
      .executeJavaScript(code)
      .then((val) => settleOp(opId, "resolve", () => handlesFromJson(vm, val)))
      .catch((e) => settleOp(opId, "reject", () => vm.newString(errorText(e))));
    return handle;
  });
  vm.setProp(storage, "get", get);
  get.dispose();

  const set = vm.newFunction("set", (keyHandle, valueHandle) => {
    const key = vm.typeof(keyHandle) === "string" ? vm.getString(keyHandle) : "";
    if (key === "") {
      pluginLog(pluginId, "warn", "storage.set: invalid key");
      return vm.undefined;
    }
    const value = vm.dump(valueHandle);
    const valueJson = JSON.stringify(value === undefined ? null : value);
    const { opId, handle } = newHostPromise(vm, pluginId, "storage.set");
    const code = storageSnippet(
      `localStorage.setItem(p+${JSON.stringify(key)},${JSON.stringify(valueJson)});return null`,
    );
    contents
      .executeJavaScript(code)
      .then(() => settleOp(opId, "resolve", () => vm.undefined))
      .catch((e) => settleOp(opId, "reject", () => vm.newString(errorText(e))));
    return handle;
  });
  vm.setProp(storage, "set", set);
  set.dispose();

  return storage;
}

// Host-owned DOM snapshot template (ADR 0002): the query/selector is inserted ONLY as JSON data and
// the snippet only reads a bounded snapshot of the matched element (never executes plugin JS).
// Returns a JSON string that the host parses into a DomElement, or `null` when nothing matched.
const DOM_QUERY_SNIPPET = (selector) =>
  `(function(){var s=JSON.parse(${JSON.stringify(JSON.stringify(selector))});try{` +
  `var e=document.querySelector(s);if(!e)return null;var st=e.tagName.toLowerCase();` +
  `var id=e.getAttribute("id")||"";var cn=e.className&&String(e.className).slice(0,256)||"";` +
  `var r=e.getBoundingClientRect();` +
  `var tx=(e.textContent||"").slice(0,1024);var at={};` +
  `for(var i=0;i<e.attributes.length&&i<64;i++){var n=e.attributes[i].name;at[n]=(e.getAttribute(n)||"").slice(0,256)}` +
  `var o={tag:st,id:id,className:cn,attrs:at,text:tx,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};` +
  `if("value" in e)o.value=String(e.value).slice(0,256);if("checked" in e)o.checked=!!e.checked;` +
  `if(o.tag==="a")o.href=(e.getAttribute("href")||"").slice(0,512);if(o.tag==="img")o.src=(e.getAttribute("src")||"").slice(0,512);` +
  `return JSON.stringify(o);}catch(e){return null}})()`;

// `ctx.dom` — renderer-only async host API (ADR 0008). `query(selector)` snapshots the first
// matching element (serialized data, never a live DOM node); `observe(selector, cb)` polls and
// re-delivers snapshots for matches, using a host-owned per-window timer, diffing the single current
// match by a coarse stable key (tag+id+short text). Requires `renderer.dom`. Each cb fires under the
// synchronous-undefined contract and is fail-closed: a throwing/over-deadline cb unregisters.
function buildDomApi(vm, pluginId, contents, cleanupCallbacks) {
  const dom = vm.newObject();
  let nextNodeId = 1;
  const nodeIds = new WeakMap(); // in the page world; here we re-derive via a stable map below.
  const observers = new Map(); // selector -> { cbHandle, lastNodes: Map<string,{nodeId}> }
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function maybeStartPolling() {
    if (pollTimer || observers.size === 0) return;
    pollTimer = setInterval(() => {
      if (contents.isDestroyed && contents.isDestroyed()) {
        stopPolling();
        return;
      }
      const selectors = [...observers.keys()];
      for (const selector of selectors) {
        const obs = observers.get(selector);
        if (!obs) continue;
        contents
          .executeJavaScript(DOM_QUERY_SNIPPET(selector))
          .then((json) => {
            // Re-read the observer by selector: a disconnect()/revoke during the in-flight poll
            // already removed it (and disposed its cbHandle), so we must not touch a stale entry.
            const panel = observers.get(selector);
            if (!panel) return;
            const snapshot = typeof json === "string" ? JSON.parse(json) : json;
            // Diff by a coarse stable key (tag+id+text hash) over the single match we poll.
            const key = snapshot ? snapshot.tag + "|" + snapshot.id + "|" + (snapshot.text || "").slice(0, 40) : null;
            if (snapshot && panel.lastKey !== key) {
              panel.lastKey = key;
              const nodeHandle = handlesFromJson(vm, { ...snapshot, nodeId: nextNodeId++ });
              const ok = runQuickJSOperation(vm, pluginId, "dom.observe callback", () =>
                vm.callFunction(panel.cbHandle, vm.undefined, nodeHandle),
                true,
              );
              nodeHandle.dispose();
              if (!ok) {
                // Fail-closed: a throwing/over-deadline callback is unregistered so it never
                // re-fires on a poisoned VM (matches the onCreated/subscribeLifecycle contract).
                observers.delete(selector);
                panel.cbHandle.dispose();
                if (observers.size === 0) stopPolling();
                pluginLog(pluginId, "warn", "dom.observe callback failed; observer unregistered");
              }
            }
          })
          .catch((e) => {
            // A persistent page error is logged but the observer survives to retry (query failure
            // is distinct from a callback failure, which is fail-closed above).
            pluginLog(pluginId, "warn", "dom.observe poll failed: " + errorText(e));
          });
      }
    }, 500);
  }

  const query = vm.newFunction("query", (selectorHandle) => {
    const selector = vm.typeof(selectorHandle) === "string" ? vm.getString(selectorHandle) : "";
    if (selector === "") {
      return vm.undefined;
    }
    const { opId, handle } = newHostPromise(vm, pluginId, "dom.query");
    contents
      .executeJavaScript(DOM_QUERY_SNIPPET(selector))
      .then((json) => {
        const snapshot = typeof json === "string" ? JSON.parse(json) : json;
        settleOp(opId, "resolve", () => (snapshot ? handlesFromJson(vm, { ...snapshot, nodeId: 0 }) : vm.null));
      })
      .catch((e) => settleOp(opId, "reject", () => vm.newString(errorText(e))));
    return handle;
  });
  vm.setProp(dom, "query", query);
  query.dispose();

  const observe = vm.newFunction("observe", (selectorHandle, cbHandle) => {
    const selector = vm.typeof(selectorHandle) === "string" ? vm.getString(selectorHandle) : "";
    if (selector === "") {
      pluginLog(pluginId, "warn", "dom.observe: invalid selector");
      return vm.undefined;
    }
    const callback = cbHandle.dup();
    // Re-observing the same selector replaces the prior observer; dispose the old callback handle
    // so it cannot outlive the subscription (and so the stale disconnect/cleanup closure no-ops on
    // the entry it no longer owns — each closure only deletes the entry it created).
    const prior = observers.get(selector);
    if (prior) prior.cbHandle.dispose();
    observers.set(selector, { cbHandle: callback, lastKey: null });
    maybeStartPolling();

    const disconnect = vm.newFunction("disconnect", () => {
      const obs = observers.get(selector);
      // Only the closure that still owns the current entry may delete it, so a stale disconnect
      // from a replaced observer never removes the newer subscription.
      if (obs && obs.cbHandle === callback) {
        observers.delete(selector);
        obs.cbHandle.dispose();
      }
      if (observers.size === 0) stopPolling();
      return vm.undefined;
    });
    // Cleanup on revoke: dispose the observer's callback handle and stop the poller when idle.
    const cleanup = () => {
      const obs = observers.get(selector);
      if (obs && obs.cbHandle === callback) {
        observers.delete(selector);
        obs.cbHandle.dispose();
      }
      if (observers.size === 0) stopPolling();
    };
    cleanupCallbacks.push(cleanup);
    return disconnect;
  });
  vm.setProp(dom, "observe", observe);
  observe.dispose();

  return dom;
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
      // Stash BrowserWindow.id onto the contents record so later
      // onRendererReady/onUnload issue the same numeric handle (unified
      // issuance). No-op when this window's contents is not yet tracked.
      if (w && w.webContents) {
        stashBrowserWindowId(windows.get(w.webContents.id), w);
      }
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
    const w = resolveWindowHandle(id);
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
    const w = resolveWindowHandle(id);
    if (w) w.setSize(vm.getNumber(wHandle), vm.getNumber(hHandle));
    return vm.undefined;
  });
  vm.setProp(win, "setSize", setSize);
  setSize.dispose();

  const setPosition = vm.newFunction("setPosition", (winHandle, xHandle, yHandle) => {
    // RT-3 (informational): see setOpacity — value coercion runs under the op's deadline.
    const id = vm.getNumber(winHandle);
    const w = resolveWindowHandle(id);
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
    const w = resolveWindowHandle(id);
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
    const w = resolveWindowHandle(id);
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
//     window record's loaded/rendererGeneration path inside start(); it passes the issued
//     WindowHandle (BrowserWindow.id when a live window is bound, else webContents.id — see
//     issuedWindowHandle). Directly usable in window ops.
//     Subscriptions made after a window already loaded fire once for each such window, mirroring
//     onCreated's existing-window replay.
//   * onUnload fires per window when its webContents is destroyed (the runtime's canonical unload
//     point — a quitting app always destroys its windows, so app shutdown is covered by the same
//     path without a separate before-quit wire that would double-fire normal per-window teardown);
//     it passes the same issued handle as onRendererReady (stashed before the record is dropped).
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
    // argValues are JS numbers (issued WindowHandles). Each is converted to a QuickJS handle
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
        const handle = issuedWindowHandle(w);
        if (handle == null) continue;
        if (!entry.invoke([handle])) break;
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
  const handle = issuedWindowHandle(w);
  if (handle == null) return;
  for (const entry of [...rendererReadyCallbacks]) {
    entry.invoke([handle]);
  }
}

// Per-window unload dispatch: fires ctx.onUnload subscribers when a window's webContents is
// destroyed (called from the webContents destroyed path in start()). `handle` is the issued
// WindowHandle (BrowserWindow.id when bound, else webContents.id).
function fireWindowUnload(handle) {
  if (handle == null) return;
  for (const entry of [...unloadCallbacks]) {
    entry.invoke([handle]);
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
    // Plain-object config read for dev-mode raw plugins (same NO-OP set contract as the sandboxed
    // ctx.config host object: config is persisted only via the Manager control plane).
    config: {
      get: (key) => (typeof key === "string" ? (plugin.config || {})[key] : undefined),
      set: () => {},
    },
    // Required surface (SDK PluginContext): real Core-side fetch when granted, denied stub that
    // returns a rejected Promise (never throws synchronously) otherwise.
    network: hasPermission(plugin.granted, "network.access")
      ? {
          request: (req) => {
            const url = req && typeof req.url === "string" ? req.url : "";
            const method =
              req && typeof req.method === "string" ? req.method.toUpperCase() : "GET";
            const headers =
              req && typeof req.headers === "object" && req.headers !== null ? req.headers : {};
            const body = req && typeof req.body === "string" ? req.body : "";
            if (!planRequest) return Promise.reject(new Error("network transport unavailable"));
            return planRequest(
              "networkRequest",
              { pluginId: plugin.id, url, method, headers, body },
              { timeout: 30000 },
            ).then(({ id, envelope }) => validatePlanEnvelope(envelope, id));
          },
        }
      : {
          request: () => Promise.reject(new Error(NETWORK_ACCESS_DENIED)),
        },
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
  if (quitting) return; // A3: no new loads once quit begins (recovery clears on continued life).
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
    // ctx.config is a read-only view of this plan snapshot's merged config for the plugin. The host
    // object is mounted before ctx becomes reachable and lives as a ctx property (no extra handles
    // to double-dispose later).
    const config = buildConfigApi(vm, plugin.id, plugin.config || {});
    vm.setProp(ctx, "config", config);
    config.dispose();
    if (hasPermission(plugin.granted, "network.access")) {
      const net = buildNetworkApi(vm, plugin.id);
      vm.setProp(ctx, "network", net);
      net.dispose();
    } else {
      // Required surface (SDK PluginContext): denied stub rejects with a catchable error.
      const net = buildNetworkDeniedApi(vm, plugin.id);
      vm.setProp(ctx, "network", net);
      net.dispose();
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
    // `global.exports`) because the plugin assigns `module.exports = {...}`. activate may return
    // undefined (synchronous, the historic contract) or a Promise/thenable it awaits to completion
    // (ADR 0008); a thenable is registered immediately and drained — see watchAsyncActivate.
    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    const activationCapture = { asyncResult: null };
    let activated = true;
    if (vm.typeof(activate) === "function") {
      activated = runLifecycleHook(
        vm,
        plugin.id,
        "main plugin activate",
        () => vm.callFunction(activate, exportsHandle, ctxHandle),
        activationCapture,
      );
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    if (!activated) {
      if (activationCapture.asyncResult) {
        try {
          activationCapture.asyncResult.dispose(); // over-deadline edge: never reached async path
        } catch (_e) {
          // Best effort.
        }
      }
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
          (hasPermission(candidate.granted, "electron.window") ||
            hasPermission(candidate.granted, "network.access")) &&
          pluginFingerprint(candidate) === fingerprint,
      ) &&
      !abuseDisabledPlugins.has(plugin.id) &&
      !mainPlugins.has(plugin.id);
    if (!stillPending) {
      if (activationCapture.asyncResult) {
        try {
          activationCapture.asyncResult.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    // Register now — immediately, even while an async activate is still in flight. First
    // deactivation runs the plugin's own module.exports.deactivate(ctx) while the VM is still
    // alive, then host cleanup, then VM disposal. The guard ensures a stale double revoke never
    // calls guest deactivate twice.
    const lifecycle = capturePluginDeactivate(vm);
    let deactivated = false;
    const deactivate = () => {
      if (deactivated) return;
      deactivated = true;
      deactivatePluginVM(vm, plugin.id, "main plugin", lifecycle, cleanupCallbacks);
    };
    const entry = { vm, deactivate, fingerprint };
    mainPlugins.set(plugin.id, entry);
    if (activationCapture.asyncResult) {
      // Async activate: watch the returned promise. Fulfillment needs no action (already
      // registered); a rejection fails the plugin closed exactly like a synchronous activate
      // failure, but is identity-guarded so a stale late rejection (the instance was superseded or
      // revoked by a plan revision) can never tear down a newer VM or dispose a VM twice.
      watchAsyncActivate(
        vm,
        plugin.id,
        "main plugin activate",
        activationCapture.asyncResult,
        (reason) => {
          if (mainPlugins.get(plugin.id) !== entry) return; // stale: superseded or already removed
          mainPlugins.delete(plugin.id);
          cleanupAll(cleanupCallbacks);
          disposeVM(vm);
          pluginLog(plugin.id, "error", "main plugin activate rejected: " + reason);
        },
      );
    }
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
  if (quitting) return; // A3: no new loads once quit begins (recovery clears on continued life).
  // A3 safety premise (R2, permanent): at most MAX_RENDERER_PLUGINS_PER_WINDOW renderer plugins
  // per window, counting active registrations plus pending reservations (raw plugins included:
  // their deactivate runs guest code with no CPU deadline). The check runs at loader entry in
  // stable plan order (reconcile iterates the plan in order), so the first eight in plan order
  // deterministically win and the rest fail closed with an error log. Without the cap the
  // background close pump's worst-case stall is unbounded (finding 5).
  {
    const suffix = "@" + w.contents.id;
    // Stable refusal (finding 4): refused under this plan once, never retried or re-logged
    // under the same plan — later async completions must not promote losers over the stable
    // first-eight. Keyed by the evaluated plan generation (not the live global, which may have
    // moved). w.capped may be absent on synthetic records; treat as empty.
    if (w.capped && w.capped.get(plugin.id) === generation) return;
    let slots = 0;
    for (const key of rendererPlugins.keys()) if (key.endsWith(suffix)) slots += 1;
    for (const key of pendingRendererPlugins.keys()) if (key.endsWith(suffix)) slots += 1;
    if (slots >= MAX_RENDERER_PLUGINS_PER_WINDOW) {
      if (w.capped) w.capped.set(plugin.id, generation);
      pluginLog(
        plugin.id,
        "error",
        "renderer plugin limit exceeded (" +
          MAX_RENDERER_PLUGINS_PER_WINDOW +
          "/window); refusing to load " +
          plugin.id +
          " for window " +
          w.contents.id,
      );
      return;
    }
  }
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
    // Host cleanup callbacks for this renderer plugin instance (e.g. dom.observe subscriptions),
    // run on revoke/deactivate before the VM is disposed.
    const cleanupCallbacks = [];
    if (hasPermission(plugin.granted, "renderer.dom")) {
      const dom = buildDomApi(vm, plugin.id, contents, cleanupCallbacks);
      vm.setProp(ctx, "dom", dom);
      dom.dispose();
    }
    // ctx.config: read-only merged config for this plan snapshot (same surface as the main ctx).
    const config = buildConfigApi(vm, plugin.id, plugin.config || {});
    vm.setProp(ctx, "config", config);
    config.dispose();
    if (hasPermission(plugin.granted, "network.access")) {
      const net = buildNetworkApi(vm, plugin.id);
      vm.setProp(ctx, "network", net);
      net.dispose();
    } else {
      // Required surface (SDK PluginContext): denied stub rejects with a catchable error.
      const net = buildNetworkDeniedApi(vm, plugin.id);
      vm.setProp(ctx, "network", net);
      net.dispose();
    }
    if (hasPermission(plugin.granted, "renderer.css")) {
      const css = buildCssApi(vm, plugin.id, w, cleanupCallbacks);
      vm.setProp(ctx, "css", css);
      css.dispose();
    }
    if (hasPermission(plugin.granted, "renderer.storage")) {
      const storage = buildStorageApi(vm, plugin.id, contents);
      vm.setProp(ctx, "storage", storage);
      storage.dispose();
    }
    if (hasPermission(plugin.granted, "electron.windowControls")) {
      const wc = buildWindowControlsApi(vm, plugin.id, w, cleanupCallbacks);
      vm.setProp(ctx, "windowControls", wc);
      wc.dispose();
    }
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
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    const moduleHandle = vm.getProp(vm.global, "module");
    const exportsHandle = vm.getProp(moduleHandle, "exports");
    const activate = vm.getProp(exportsHandle, "activate");
    const ctxHandle = vm.getProp(vm.global, "ctx");
    const activationCapture = { asyncResult: null };
    let activated = true;
    if (vm.typeof(activate) === "function") {
      activated = runLifecycleHook(
        vm,
        plugin.id,
        "renderer plugin activate",
        () => vm.callFunction(activate, exportsHandle, ctxHandle),
        activationCapture,
      );
    }
    activate.dispose();
    ctxHandle.dispose();
    exportsHandle.dispose();
    moduleHandle.dispose();

    if (!activated) {
      if (activationCapture.asyncResult) {
        try {
          activationCapture.asyncResult.dispose(); // over-deadline edge: never reached async path
        } catch (_e) {
          // Best effort.
        }
      }
      cleanupAll(cleanupCallbacks);
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
          (hasPermission(candidate.granted, "renderer.script") ||
            hasPermission(candidate.granted, "network.access") ||
            hasPermission(candidate.granted, "renderer.storage") ||
            hasPermission(candidate.granted, "renderer.dom")) &&
          pluginFingerprint(candidate) === fingerprint,
      ) &&
      !abuseDisabledPlugins.has(plugin.id) &&
      !rendererPlugins.has(key);
    if (!stillWanted) {
      if (activationCapture.asyncResult) {
        try {
          activationCapture.asyncResult.dispose();
        } catch (_e) {
          // Best effort.
        }
      }
      cleanupAll(cleanupCallbacks);
      disposeVM(vm);
      return;
    }

    // Same lifecycle contract as main plugins: deactivation first runs the plugin's own
    // module.exports.deactivate(ctx) while the VM is still alive, then disposes the VM. Guarded so
    // a stale double revoke never calls guest deactivate twice. Register immediately, even while an
    // async activate is still in flight (a rejection fails the plugin closed, identity-guarded so a
    // stale late rejection never tears down a newer VM).
    const lifecycle = capturePluginDeactivate(vm);
    let deactivated = false;
    // lifecycle/cleanups are retained on the entry so a window-close batch can service this
    // plugin's teardown in the background pump without re-entering through deactivate().
    const entry = { vm, fingerprint, deactivate: null, lifecycle, cleanups: cleanupCallbacks };
    entry.deactivate = () => {
      // closeClaimed entries are owned by a close batch (A3 transfer neutralized this closure);
      // any stale caller besides the batch is a no-op so guest deactivate runs at most once.
      if (deactivated || entry.closeClaimed) return;
      deactivated = true;
      deactivatePluginVM(vm, plugin.id, "renderer plugin", lifecycle, cleanupCallbacks);
    };
    rendererPlugins.set(key, entry);
    if (activationCapture.asyncResult) {
      watchAsyncActivate(
        vm,
        plugin.id,
        "renderer plugin activate",
        activationCapture.asyncResult,
        (reason) => {
          if (rendererPlugins.get(key) !== entry) return; // stale: superseded or already removed
          rendererPlugins.delete(key);
          cleanupAll(cleanupCallbacks);
          disposeVM(vm);
          pluginLog(plugin.id, "error", "renderer plugin activate rejected: " + reason);
        },
      );
    }
    pluginLog(plugin.id, "info", "Renderer plugin loaded");
  }).catch((e) => {
    if (pendingRendererPlugins.get(key) === pending) pendingRendererPlugins.delete(key);
    cleanupAll(cleanupCallbacks);
    if (vm) disposeVM(vm);
    pluginLog(plugin.id, "error", "QuickJS init failed: " + (e && e.message ? e.message : e));
  });
}

function reconcileRendererPlugins(w) {
  const contents = w.contents;
  const wanted = new Map();
  // A3 quit gate: once quit begins, no NEW plugin loads (removals below still run so
  // revocation stays effective while quitting). Recovery clears `quitting` on continued
  // host life (new window content), so normal operation is unaffected.
  const addsAllowed = !quitting;
  for (const p of currentPlan.plugins) {
    if (p.renderer && (hasPermission(p.granted, "renderer.script") || hasPermission(p.granted, "runtime.unsafe") || hasPermission(p.granted, "network.access") || hasPermission(p.granted, "renderer.storage") || hasPermission(p.granted, "renderer.dom"))) {
      wanted.set(p.id, { plugin: p, fingerprint: pluginFingerprint(p) });
    }
  }

  // R2 reorder squeeze (finding 4): rank the current plan's renderer wants in stable plan
  // order. Actives ranked at eight or beyond are deactivated even when fingerprints match, so
  // the cap holds when a reorder squeezes previously-loaded plugins out; pendings beyond eight
  // are cancelled before they resolve. Removal of a loaded winner lets the next candidate
  // promote deterministically on a later reconcile (its capped refusal, if any, was recorded
  // under an older plan generation and no longer applies).
  const rankOf = new Map();
  for (const p of currentPlan.plugins) {
    if (p.renderer && (hasPermission(p.granted, "renderer.script") || hasPermission(p.granted, "runtime.unsafe") || hasPermission(p.granted, "network.access") || hasPermission(p.granted, "renderer.storage") || hasPermission(p.granted, "renderer.dom"))) {
      if (!rankOf.has(p.id)) rankOf.set(p.id, rankOf.size);
    }
  }
  {
    const suffix = "@" + contents.id;
    for (const [key, entry] of [...rendererPlugins]) {
      if (!key.endsWith(suffix)) continue;
      const rank = rankOf.has(key.slice(0, -suffix.length))
        ? rankOf.get(key.slice(0, -suffix.length))
        : Infinity;
      if (rank >= MAX_RENDERER_PLUGINS_PER_WINDOW) {
        rendererPlugins.delete(key);
        entry.deactivate();
        pluginLog(
          key.slice(0, -suffix.length),
          "info",
          "renderer plugin squeezed out by plan reorder (beyond 8/window)",
        );
      }
    }
    for (const key of [...pendingRendererPlugins.keys()]) {
      if (!key.endsWith(suffix)) continue;
      const rank = rankOf.has(key.slice(0, -suffix.length))
        ? rankOf.get(key.slice(0, -suffix.length))
        : Infinity;
      // Loader continuations re-check map identity, so a cancelled pending fast-fails silently.
      if (rank >= MAX_RENDERER_PLUGINS_PER_WINDOW) pendingRendererPlugins.delete(key);
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
      if (addsAllowed) runRendererPlugin(want.plugin, w, planGeneration, want.fingerprint);
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

// --- A3 background close machinery ---
//
// destroyed transfers teardown here; the pump services one plugin slice per macrotask,
// round-robin across windows (finding 6 fairness), preserving deactivate-before-unload
// order inside each window's batch (finding 3: no contract change).

// Synchronously abandon a sealing VM's in-flight host ops: dispose their deferreds so no
// later settlement can create handles, and drop its drain guard. Runs inside the destroyed
// transfer (before any setImmediate), so the isolation window is zero.
function abandonVmOps(vm) {
  cleanupPendingOps(vm);
}

// Stop a dead window's polling/subscription surfaces synchronously at transfer, without
// touching Electron: each snapshot's host cleanups run now (dom cleanup stops its poller and
// disposes callback handles; css cleanup drops live-keys — removal against destroyed contents
// fast-fails inside removeCssKey). All cleanups are idempotent, so the background slice's
// defensive re-run is a no-op. In-flight query resolutions fast-fail on the missing panel.
function quenchRecord(rec, actSnaps) {
  if (!rec) return;
  try {
    if (rec.quenched) return;
    rec.quenched = true;
  } catch (_e) {
    return;
  }
  for (const snap of actSnaps || []) {
    if (!snap.cleanups) continue;
    try {
      cleanupAll(snap.cleanups);
    } catch (_e) {
      // Quench must never throw out of the destroyed handler.
    }
  }
}

function suffixKeys(map, suffix) {
  const out = [];
  for (const key of map.keys()) if (key.endsWith(suffix)) out.push(key);
  return out;
}

// Async variant of drainThenableResult: same 2000ms wall cap (DEACTIVATE_DRAIN_MS) and same
// settlement semantics, but polls across setImmediate turns so the event loop (surviving
// windows, DUR-1 polling) is never held hostage by one guest cleanup. Resolves
// "fulfilled" / "rejected" / "timeout". Does not dispose promiseHandle (caller-owned).
function asyncDrainThenableResult(vm, pluginId, label, promiseHandle, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (vmSealed.has(vm) && !teardownActive.has(vm)) {
        resolve("timeout");
        return;
      }
      drainPendingJobs(vm, pluginId, label);
      let state;
      try {
        state = vm.getPromiseState(promiseHandle);
      } catch (_e) {
        resolve("fulfilled"); // VM is going away; treat as settled so disposal proceeds.
        return;
      }
      if (state.type === "fulfilled") {
        if (!state.notAPromise && state.value) {
          try {
            state.value.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
        resolve("fulfilled");
        return;
      }
      if (state.type === "rejected") {
        if (state.error) {
          try {
            state.error.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
        resolve("rejected");
        return;
      }
      if (Date.now() >= deadline) {
        resolve("timeout");
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

// Background-service one snapshotted renderer entry: guest deactivate (same contract as
// deactivatePluginVM: sync-undefined or drained thenable, failures logged fail-closed),
// then host cleanup, handle release, and VM disposal. Never throws.
async function asyncDeactivateSnap(snap) {
  const { vm, pluginId, lifecycle, cleanups } = snap;
  teardownActive.add(vm);
  try {
    if (lifecycle && lifecycle.deactivateExport) {
      const capture = { asyncResult: null };
      const ok = runLifecycleHook(
        vm,
        pluginId,
        "renderer plugin deactivate",
        () => vm.callFunction(lifecycle.deactivateExport, lifecycle.moduleExports, lifecycle.ctx),
        capture,
      );
      if (!ok) {
        if (capture.asyncResult) {
          try {
            capture.asyncResult.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
        pluginLog(
          pluginId,
          "error",
          "renderer plugin deactivate failed or returned a non-undefined result; continuing with disposal",
        );
      } else if (capture.asyncResult) {
        const outcome = await asyncDrainThenableResult(
          vm,
          pluginId,
          "renderer plugin deactivate",
          capture.asyncResult,
          DEACTIVATE_DRAIN_MS,
        );
        try {
          capture.asyncResult.dispose();
        } catch (_e) {
          // Best effort.
        }
        if (outcome !== "fulfilled") {
          pluginLog(
            pluginId,
            "error",
            "renderer plugin deactivate failed or timed out; continuing with disposal",
          );
        }
      }
    }
  } finally {
    for (const handle of [lifecycle && lifecycle.deactivateExport, lifecycle && lifecycle.ctx, lifecycle && lifecycle.moduleExports]) {
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
    teardownActive.delete(vm);
  }
}

// Background-service one snapshotted RAW entry (finding 2): run its own deactivate closure,
// which executes the raw guest cleanup synchronously with full host parity, guarded internally
// against throws and double runs. Raw entries carry no VM, lifecycle handles, or host cleanups,
// so there is nothing else to release. Never throws.
async function rawDeactivateSlice(snap) {
  try {
    snap.rawDeactivate();
  } catch (_e) {
    // runRawPlugin's deactivate already guards throws/double-runs; this covers defects.
  }
}

// Deliver one window batch's unload snapshot: each entry at most once for this window.
// Entries revoked after the snapshot (no longer subscribed) are skipped: their plugin is gone
// and delivery would run guest code on a disposed VM. Entries subscribed after the snapshot
// were never captured, so they can never receive this window's unload (finding 2).
function fireUnloadSnapshot(batch) {
  for (const snapEntry of batch.unloadSnap) {
    if (!snapEntry) continue;
    if (!unloadCallbacks.has(snapEntry)) continue;
    try {
      snapEntry.invoke([batch.handle]);
    } catch (_e) {
      // invoke() is fail-closed internally; this guards the snapshot loop itself.
    }
  }
}

function scheduleClosePump() {
  if (closePumpScheduled) return;
  closePumpScheduled = true;
  setImmediate(pumpCloseQueue);
}

// Round-robin, single slice per macrotask (Gate 2R): each pump turn starts at most one
// slice — the first eligible batch in queue order — then yields, so one turn's synchronous
// prefix (a guest deactivate call, bounded by the CPU deadline) never multiplies across
// windows. The served batch rotates behind newer arrivals, so consecutive turns alternate
// across windows. Each batch still carries at most one in-flight slice (inFlightCount); a
// batch whose slice is running is skipped, never re-entered, and its unload waits until every
// in-flight teardown of that batch completes. Wakeups need no trailing schedule: every started
// slice reschedules on completion, and transfers/sweeps schedule explicitly — an all-in-flight
// queue therefore sleeps instead of spinning.
function pumpCloseQueue() {
  closePumpScheduled = false;
  for (let i = 0; i < closeQueue.length; i += 1) {
    const batch = closeQueue[i];
    if (batch.inFlightCount > 0) continue;
    const snap = batch.actSnaps[batch.cursor];
    if (!snap) continue;
    batch.cursor += 1;
    batch.inFlightCount += 1;
    // Rotate behind newer arrivals so the next turn serves another window first.
    closeQueue.splice(i, 1);
    closeQueue.push(batch);
    const work = snap.raw ? rawDeactivateSlice(snap) : asyncDeactivateSnap(snap);
    work
      .catch(() => {})
      .then(() => {
        batch.inFlightCount -= 1;
        scheduleClosePump();
      });
    break; // exactly one slice per macrotask
  }
  // Fire unload for every fully serviced batch, wherever it sits in the queue: completion
  // order, not arrival order. Each unload carries its own window handle and no cross-window
  // unload order is contracted, so holding a finished batch behind a slow head would be pure
  // head-of-line blocking (finding 6). A batch leaves the queue only here — so queue-empty
  // still implies no in-flight teardown anywhere. No trailing schedule: every started slice
  // reschedules on completion and transfers/sweeps schedule explicitly, so an all-in-flight
  // queue sleeps instead of spinning.
  for (let i = closeQueue.length - 1; i >= 0; i -= 1) {
    const batch = closeQueue[i];
    if (batch.inFlightCount > 0 || batch.cursor < batch.actSnaps.length) continue;
    closeQueue.splice(i, 1);
    fireUnloadSnapshot(batch);
  }
}

// will-quit safety sweep (findings 2/3/4): dispose any QuickJS VMs the background pump has
// not reached, WITHOUT running guest deactivate (not even raw: raw guest code may block quit
// without any deadline, so the dispose-only exit tier applies to every plugin kind — finding 2)
// and WITHOUT emitting unload (no double-fire by construction: unload stays queued for the
// pump). The loop starts at batch.cursor, so a slice already in flight (index cursor-1 while
// inFlightCount is 1) is never touched: when it completes, the pump still fires this batch's
// unload afterwards, preserving deactivate-before-unload even across the "drain started, then
// will-quit, then cancel" race (finding 3). Raw snaps are left in place for the pump (their
// guest cleanup still runs in a surviving process); only disposed QuickJS snaps are compacted
// out, so a repeat will-quit finds nothing left to dispose (idempotent). If the process exits
// first, the undelivered unloads and unrun raw cleanups are the documented R1 best-effort exit
// semantic — VM disposal, the fail-closed half, is already complete here. Dispose-only here (no
// guest code runs), so quit is never held hostage by guest cleanup; no upper bound on a slow
// disposeVM itself is declared.
function sweepUndisposedSync() {
  let serviced = false;
  for (const batch of closeQueue) {
    const remaining = [];
    for (let i = batch.cursor; i < batch.actSnaps.length; i += 1) {
      const snap = batch.actSnaps[i];
      if (!snap) continue;
      // Raw snaps carry no VM to dispose and their guest cleanup must not run on the quit
      // path (finding 2): leave them queued for the pump (surviving process) or for R1 loss
      // on process termination.
      if (snap.raw || !snap.vm) {
        remaining.push(snap);
        continue;
      }
      serviced = true;
      // Release retained lifecycle handles first: disposeVM frees the runtime, and any live
      // handle left over would trip QuickJS's GC-empty assertion at FreeRuntime.
      const lc = snap.lifecycle;
      for (const handle of [lc && lc.deactivateExport, lc && lc.ctx, lc && lc.moduleExports]) {
        if (handle) {
          try {
            handle.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
      }
      try {
        if (snap.cleanups) cleanupAll(snap.cleanups);
      } catch (_e) {
        // Best effort.
      }
      try {
        disposeVM(snap.vm);
      } catch (_e) {
        // Best effort.
      }
      teardownActive.delete(snap.vm);
    }
    batch.actSnaps = batch.actSnaps.slice(0, batch.cursor).concat(remaining);
  }
  if (serviced) scheduleClosePump();
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
  // A3 quit gate: see reconcileRendererPlugins — adds refused while quitting, removals run.
  const addsAllowed = !quitting;
  for (const p of currentPlan.plugins) {
    if (p.main && (hasPermission(p.granted, "electron.window") || hasPermission(p.granted, "runtime.unsafe") || hasPermission(p.granted, "network.access"))) {
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
        if (addsAllowed) runMainPlugin(p, app, planGeneration, fingerprint);
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

  // A3 quit semantics (R1): before-quit is ONLY a mode switch for the allocator gate below —
  // never a flush, never an event (a flush here would race the not-yet-destroyed windows and
  // reintroduce the 250ms/order conflict). Delivery is owned by the destroyed transfer plus
  // the background pump, which runs during quit's window-closing phase. will-quit runs a
  // dispose-only sweep (no guest code, no unload events): no VM is ever left undisposed while
  // the process lives, and exit never waits on guest cleanup. All three hooks are persistent
  // (app.on, idempotent bodies) so repeat quits re-latch and re-sweep correctly (finding 3):
  // a cancelled quit recovers the allocator via continued host life (new window content,
  // window focus, or app re-activation below), while already-transferred batches stay valid —
  // their windows are genuinely gone — and keep pumping because the loop is alive.
  if (app && typeof app.on === "function") {
    app.on("before-quit", () => {
      quitting = true;
    });
    // A quit cancelled with no new window still resumes: focusing any window or re-activating
    // the app proves continued life and reopens the allocator.
    app.on("browser-window-focus", () => {
      quitting = false;
    });
    // 'activate' is macOS-dock-centric but harmless elsewhere; kept as one more recovery
    // signal alongside focus/created/load.
    app.on("activate", () => {
      quitting = false;
    });
    app.on("will-quit", () => {
      try {
        sweepUndisposedSync();
      } catch (_e) {
        // Best effort — the process is exiting regardless.
      }
    });
  }

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

      // Generic Window Controls Overlay (WCO) elimination seam. When the selected adapter exposes
      // onWindowOptions (currently wco, for apps that create their window with titleBarStyle
      // "hidden" + titleBarOverlay), rewrite every LATER `new BrowserWindow(opts)` issued by the
      // target main process so the adapter can drop the overlay. Only subsequent constructions are
      // affected — no target file is touched and nothing is drawn. Fail-open: on any error log a
      // warning and keep the original BrowserWindow working.
      const adapterWindowOpts = adapter && typeof adapter.onWindowOptions === "function";
      if (adapterWindowOpts) {
        try {
          // Function-wrapper + Object.setPrototypeOf keeps the constructor semantics and static
          // members of the real class while funneling options through the adapter. This is handed
          // to the electron module-resolution shim (ADR 0009): a Proxy facade's BrowserWindow
          // getter returns this wrapper, so target code that requires("electron") and constructs a
          // window gets the wrapper — the options are rewritten before the real constructor runs.
          const WrappedBrowserWindow = function (...args) {
            const opts = args[0] && typeof args[0] === "object" ? args[0] : {};
            const next = adapters.applyWindowOptions(adapter, opts);
            args[0] = next;
            return new RealBrowserWindow(...args);
          };
          Object.setPrototypeOf(WrappedBrowserWindow, RealBrowserWindow);
          WrappedBrowserWindow.prototype = RealBrowserWindow.prototype;
          // Static method forwarding (fromId/getAllWindows etc.), avoiding breakage.
          for (const k of Object.getOwnPropertyNames(RealBrowserWindow)) {
            if (k === "length" || k === "name" || k === "prototype") continue;
            try {
              if (!(k in WrappedBrowserWindow)) WrappedBrowserWindow[k] = RealBrowserWindow[k];
            } catch (_e) {
              // non-writable static — skip
            }
          }
          if (shim.installElectronFacade(() => WrappedBrowserWindow)) {
            log("wco adapter active: BrowserWindow WCO overlay removal enabled (electron require facade)");
          } else {
            log("wco adapter active: electron require facade install failed; original BrowserWindow kept", "warn");
          }
        } catch (e) {
          log(
            "BrowserWindow WCO overlay removal failed; continuing with original BrowserWindow: " +
              (e && e.message ? e.message : e),
            "warn",
          );
        }
      }
    } else {
      log("no compat adapter matched", "warn");
    }
  } catch (e) {
    log("compat adapter bootstrap failed: " + (e && e.message ? e.message : e), "error");
  }

  app.on("web-contents-created", (_e, contents) => {
    // Host-internal surfaces first: the window-controls overlay's WebContents
    // reports getType() === "window" exactly like a real target, so the type
    // check below cannot exclude it. The synchronous construction guard covers
    // events fired re-entrantly inside `new WebContentsView()`; the registry
    // covers later emissions. Excluded surfaces never enter `windows`: no
    // plugins load in them and no nested overlay can recurse.
    if (internalOverlayConstructionDepth > 0) return;
    try {
      if (contents && internalOverlayContents.has(contents)) return;
    } catch (_e) {
      // Best effort — fall through to the type check.
    }
    if (contents.getType() !== "window") {
      return;
    }
    // A cancelled quit leaves the process alive: new window content proves continued life and
    // ends quit-mode allocation gating (finding 4 recovery; before-quit is only a switch).
    if (quitting) quitting = false;
    const w = {
      contents,
      keys: new Map(),
      gens: new Map(),
      loaded: false,
      rendererGeneration: 0,
      // A3 R2 stable refusal: pluginId -> planGeneration under which this window refused it.
      // A refused plugin is never retried nor re-logged under the same plan, regardless of later
      // slot drift from async completions (finding 4). A new plan generation re-evaluates.
      capped: new Map(),
    };
    windows.set(contents.id, w);
    contents.on("destroyed", () => {
      // A3 transfer: synchronous bookkeeping only — the native window must be releasable the
      // moment this handler returns. Guest deactivate / disposal / unload delivery run in the
      // background pump (pumpCloseQueue). Observable order (deactivate before onUnload) is
      // preserved inside each window's batch (finding 3: no contract change).
      const rec = windows.get(contents.id);
      // Main-plugin lifecycle (SPEC §9 onUnload): fires per window when its webContents is
      // destroyed. A quitting app always destroys its windows, so app shutdown reaches the same
      // path — a separate before-quit event wire would double-fire normal per-window teardown
      // (before-quit is only a mode switch, q.v. start()).
      if (!rec || rec.dead) return; // duplicate destroyed / re-entrant: only first transfer counts
      rec.dead = true;
      rec.readyArmed = false; // late adapter-gate ready() must no-op (see onReady guard below)
      const contentsId = contents.id;
      // Unified WindowHandle issuance (PR#1 semantics on the PR#2 async path): issue before the
      // record is dropped so a stashed BrowserWindow.id survives. The batch delivers onUnload
      // with this handle (fireUnloadSnapshot reads batch.handle).
      const handle = issuedWindowHandle(rec, contentsId);
      windows.delete(contentsId);
      // Cancel pending loaders for this window (loader continuations re-check identity and the
      // windows map, so any late resolution fast-fails without creating VMs).
      const suffix = "@" + contentsId;
      for (const key of [...pendingRendererPlugins.keys()]) {
        if (key.endsWith(suffix)) pendingRendererPlugins.delete(key);
      }
      // Extract active entries, neutralizing their sync deactivate closures so teardown runs
      // exactly once, via this batch (stale callers of entry.deactivate() become no-ops).
      const actSnaps = [];
      for (const [key, entry] of [...rendererPlugins]) {
        if (!key.endsWith(suffix)) continue;
        rendererPlugins.delete(key);
        entry.closeClaimed = true;
        if (entry.vm) {
          // Seal first: from here no async source except this batch may touch the VM, and its
          // in-flight host ops are abandoned synchronously (zero isolation window).
          abandonVmOps(entry.vm);
          vmSealed.add(entry.vm);
          actSnaps.push({
            key,
            pluginId: key.slice(0, -suffix.length),
            vm: entry.vm,
            lifecycle: entry.lifecycle || null,
            cleanups: entry.cleanups || null,
          });
        } else {
          // Raw (runtime.unsafe) entries carry no VM: snapshot their deactivate closure so the
          // background pump still runs guest cleanup in a surviving process (finding 2). Without
          // this the neutralized closure below would drop raw cleanup entirely.
          actSnaps.push({
            key,
            pluginId: key.slice(0, -suffix.length),
            vm: null,
            raw: true,
            rawDeactivate: entry.deactivate,
          });
        }
        entry.deactivate = () => {};
      }
      quenchRecord(rec, actSnaps);
      // Subscriber snapshot: unload receivers fixed at destroy; later subscribers and later
      // plan revisions never receive this window's unload (finding 2). Revoked-after-snapshot
      // entries are filtered at delivery (their VMs are sealed).
      const unloadSnap = [...unloadCallbacks];
      // inFlightCount tracks slices started-but-unfinished for this batch (finding 1: at most
      // one per batch; unload waits for zero).
      closeQueue.push({ handle, contentsId, seq: ++closeSeqCounter, actSnaps, unloadSnap, cursor: 0, inFlightCount: 0 });
      scheduleClosePump();
    });
    contents.on("did-finish-load", () => {
      // Path A renderer-timing seam: the active adapter may opt into `renderer.gate(win, ready)`
      // to delay injection until the app's OWN UI-ready signal (e.g. Obsidian's `.workspace`).
      // `win` is this window record; `ready()` runs the existing reconcile. Fail-open: the gate
      // must call ready() exactly once within a bounded timeout (makeSelectorGate), and a throwing
      // gate falls back to the default timing below.
      const onReady = () => {
        // A3 isolation: a late adapter-gate ready() for a transferred (dead) window must not
        // resurrect it — no reconcile, no plugin creation, no events. Recovery: quitting mode
        // ends when host life demonstrably continues (a load reaching this live path).
        if (w.dead || w.readyArmed === false || windows.get(contents.id) !== w) return;
        if (quitting) quitting = false;
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
  internalOverlayContents.clear();
  internalOverlayConstructionDepth = 0;
  appRef = null;
  activeAdapter = null;
  mainPlugins.clear();
  pendingMainPlugins.clear();
  rendererPlugins.clear();
  pendingRendererPlugins.clear();
  // A3: deterministically retire queued close batches (dispose-only, no guest code, no events)
  // so no test observes another test's background teardown and no VM leaks across reset.
  for (const batch of closeQueue.splice(0, closeQueue.length)) {
    for (const snap of batch.actSnaps || []) {
      const lc = snap.lifecycle;
      for (const handle of [lc && lc.deactivateExport, lc && lc.ctx, lc && lc.moduleExports]) {
        if (handle) {
          try {
            handle.dispose();
          } catch (_e) {
            // Best effort.
          }
        }
      }
      try {
        if (snap.cleanups) cleanupAll(snap.cleanups);
      } catch (_e) {
        // Best effort.
      }
      try {
        if (snap.vm) disposeVM(snap.vm);
      } catch (_e) {
        // Best effort.
      }
      if (snap.vm) teardownActive.delete(snap.vm);
    }
  }
  closePumpScheduled = false;
  quitting = false;
  abuseDisabledPlugins.clear();
  vmDisposeCount = 0;
  quickJSGetCount = 0;
  // Async-op pump state: drop drain guards for any VM that still has pending ops, then clear the
  // registry and counters so a later harness test starts from a clean slate. (WeakMap entries for
  // VMs already disposed via disposeVM were removed by cleanupPendingOps.)
  for (const op of pendingOps.values()) {
    vmDrains.delete(op.vm);
  }
  pendingOps.clear();
  nextOpId = 1;
  pumpDrainCount = 0;
  loadCallbacks.clear();
  rendererReadyCallbacks.clear();
  unloadCallbacks.clear();
  appLoaded = false;
  hostPlatform = process.platform;
  windowResolver = (id) => BrowserWindow.fromId(id);
  windowEnumerator = defaultWindowEnumerator;
  windowHandleMode = WINDOW_HANDLE_MODE_UNIFIED;
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
    // Live-window enumeration seam for the bun harness: resolveWindowHandle's
    // contents-id fallback scans these windows, so tests enumerate their fake
    // windows hermetically regardless of which "electron" stub index.js
    // captured at load. reset() restores production Electron enumeration.
    setWindowEnumerator: (enumerator) => {
      windowEnumerator =
        typeof enumerator === "function" ? enumerator : defaultWindowEnumerator;
    },
    // Issuance-mode seam for the reverse-proof collision test: "legacy-mixed-ids"
    // restores Gate 3 mixed issuance (rr/ul pass webContents.id) so the A/B
    // fixture misroutes through resolveWindowHandle's fromId-first step.
    // Anything else (including omit/reset) is unified BrowserWindow.id issuance.
    setWindowHandleMode: (mode) => {
      windowHandleMode =
        mode === WINDOW_HANDLE_MODE_LEGACY
          ? WINDOW_HANDLE_MODE_LEGACY
          : WINDOW_HANDLE_MODE_UNIFIED;
    },
    resolveWindowHandle: (id) => resolveWindowHandle(id),
    // Async-op pump seams for the bun harness (src/async-pump.test.js): the harness spawns a real
    // QuickJS context, registers host functions backed by newHostPromise, settles ops through
    // settleOp/disposeVM, and asserts on the live pump state. These exist only so the feature tests
    // stay hermetic; the whole __testing object is inert in the bundled runtime (the public contract
    // stays { start, applyPlan }).
    getQuickJS: () => getQuickJS(),
    newHostPromise: (vm, pluginId, label) => newHostPromise(vm, pluginId, label),
    settleOp: (id, mode, makeHandle) => settleOp(id, mode, makeHandle),
    drainPendingJobs: (vm, pluginId, label) => drainPendingJobs(vm, pluginId, label),
    disposeVM: (vm) => disposeVM(vm),
    pendingOps: () => pendingOps,
    vmDrains: () => vmDrains,
    pendingOpsSize: () => pendingOps.size,
    // A3 close-path seams: queued background batches, VM sealing, quit-mode switch.
    closeQueueSize: () => closeQueue.length,
    isVmSealed: (vm) => vmSealed.has(vm),
    isQuitting: () => quitting,
    maxRendererPluginsPerWindow: () => MAX_RENDERER_PLUGINS_PER_WINDOW,
    drainCount: () => pumpDrainCount,
    quickJSInterruptCount: (vm) => quickJSInterruptCounts.get(vm) || 0,
    implementedRendererCapabilities: () => [...IMPLEMENTED_RENDERER_CAPABILITIES],
    implementedLevelTwoCapabilities: () => [...IMPLEMENTED_LEVEL_TWO_CAPABILITIES],
    implementedLevelTwoDeveloperCapabilities: () => [
      ...IMPLEMENTED_LEVEL_TWO_DEVELOPER_CAPABILITIES,
    ],
  },
};

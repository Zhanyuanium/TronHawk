// Host-hosted declarative window-controls overlay (`electron.windowControls`).
//
// Trusted design (Gate 1 remediation): the host renders traffic lights in an
// INDEPENDENT WebContentsView (separate WebContents, safe webPreferences,
// data-URL HTML, no <script>, no preload) and binds real user clicks via the
// overlay view's `setWindowOpenHandler` (links carry `target="_blank"`:
// verified then always denied) plus `will-navigate` / `will-frame-navigate`
// interception as the fallback path (registration-source boundary plus
// per-window-token-verified, twin-dedup). The target page is never injected and never listened on for
// window actions, so page forgeries cannot reach window ops.
// `mount()` fails closed without a live BrowserWindow or a trusted view.
//
// Exercises `src/index.js` (buildWindowControlsApi dispatch + ownership state
// machine + cleanup) against a stub Electron host with real QuickJS
// sandboxes, plus the pure helpers in `src/window-controls.js`.
//
// Run with `bun test` from crates/runtime/js.
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

const electron = {
  BrowserWindow: { getAllWindows: () => [], fromId: () => null },
  app: new EventEmitter(),
  protocol: {},
};
mock.module("electron", () => electron);

const runtime = require("./index.js");
const testing = runtime.__testing;
const wc = require("./window-controls.js");
const { applyPlan } = runtime;

let pluginLogs = [];
let pageSnippets = []; // main-page executeJavaScript (must stay empty: no page injection, no page cleanup)
let overlaySnippets = []; // trusted-view executeJavaScript (sync only)
let overlayNavigations = []; // overlay will-navigate urls (for debugging)
let fakeWindows = new Map();
let nextContentsId = 1;
let nextOverlayId = 1000;
let loadDelayMs = 0;
let loadShouldReject = null;
let loadRejectOnce = false;
// Simulates old Electron without per-view window-open interception: the
// mount must fall back to the navigation path.
let omitWindowOpenHandler = false;

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) => pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

const PID = "com.example.wc";
const PID2 = "com.example.wc2";

function planFor(revision, plugins) {
  return { revision, plugins };
}

function pluginEntry(id, grants, rendererSource) {
  return { id, version: "1", granted: grants, renderer: rendererSource, css: null, main: null };
}

// --- Fake trusted overlay view (host-controlled, separate WebContents) ---

function makeOverlayContents() {
  const oc = new EventEmitter();
  oc.id = nextOverlayId++;
  // Like the real platform, the overlay's WebContents reports getType() as a
  // window: type filtering alone must never admit it to target discovery.
  oc.getType = () => "window";
  oc.__destroyed = false;
  oc.isDestroyed = () => oc.__destroyed;
  oc.loadURL = async (url) => {
    overlayNavigations.push(url);
    if (loadDelayMs > 0) await new Promise((r) => setTimeout(r, loadDelayMs));
    if (loadRejectOnce) {
      loadRejectOnce = false;
      throw new Error(loadShouldReject || "overlay load failed");
    }
    if (loadShouldReject) throw new Error(loadShouldReject);
    return "ok";
  };
  const origExecute = async (snippet) => {
    overlaySnippets.push(snippet);
    return "synced";
  };
  oc.executeJavaScript = origExecute;
  // Single-slot window-open interception, like the real platform: installing
  // replaces the previous handler; nothing fires after close().
  oc.__windowOpenHandler = null;
  if (!omitWindowOpenHandler) {
    oc.setWindowOpenHandler = (handler) => {
      oc.__windowOpenHandler = handler;
    };
    oc.openWindow = (details) => oc.__windowOpenHandler(details);
  }
  oc.close = () => {
    oc.__destroyed = true;
    oc.__windowOpenHandler = null;
    oc.removeAllListeners("will-navigate");
    oc.removeAllListeners("will-frame-navigate");
  };
  oc.destroy = oc.close;
  return oc;
}

function FakeWebContentsView(options) {
  if (FakeWebContentsView.throwOnConstruct) throw new Error("view construct failed");
  this.options = options;
  this.webContents = makeOverlayContents();
  // Like real Electron, construction synchronously announces the fresh
  // WebContents. The host must exclude it from target discovery even though
  // getType() says "window": no window record, no plugins, no nested overlay.
  electron.app.emit("web-contents-created", null, this.webContents);
  this.bounds = null;
  FakeWebContentsView.created.push(this);
}
FakeWebContentsView.created = [];
FakeWebContentsView.throwOnConstruct = false;
FakeWebContentsView.prototype.setBounds = function (b) {
  this.bounds = { ...b };
};
FakeWebContentsView.prototype.setBackgroundColor = function (c) {
  this.backgroundColor = c;
};

// --- Fake page window (BrowserWindow with contentView seam) ---

function createFakeWindow(contentsId) {
  const win = new EventEmitter();
  win.id = 100 + contentsId;
  win.webContents = { id: contentsId };
  win.calls = [];
  win._maximized = false;
  win.minimize = () => win.calls.push(["minimize"]);
  win.maximize = () => {
    win._maximized = true;
    win.calls.push(["maximize"]);
  };
  win.unmaximize = () => {
    win._maximized = false;
    win.calls.push(["unmaximize"]);
  };
  win.close = () => win.calls.push(["close"]);
  win.isMaximized = () => win._maximized;
  win.contentView = {
    children: [],
    addChildView(v) {
      this.children.push(v);
    },
    removeChildView(v) {
      this.children = this.children.filter((c) => c !== v);
    },
  };
  return win;
}

function makePageContents() {
  const contents = new EventEmitter();
  contents.id = nextContentsId++;
  contents.getType = () => "window";
  contents.insertCSS = async () => "k";
  contents.removeInsertedCSS = async () => {};
  contents.isDestroyed = () => false;
  contents.executeJavaScript = async (snippet) => {
    pageSnippets.push(snippet);
    return "cleaned";
  };
  return contents;
}

function loadPlugins({ plugins, revision = "r1" }) {
  const c = makePageContents();
  const win = createFakeWindow(c.id);
  fakeWindows.set(win.id, win);
  testing.setWindowEnumerator(() => [...fakeWindows.values()]);
  testing.setWindowResolver((id) => fakeWindows.get(id) || null);
  electron.app.emit("web-contents-created", null, c);
  applyPlan(planFor(revision, plugins));
  c.emit("did-finish-load");
  return { contents: c, win };
}

function loadOne({ grants, rendererSource, revision = "r1" }) {
  return loadPlugins({
    plugins: [pluginEntry(PID, grants, rendererSource)],
    revision,
  });
}

const WC_GRANTS = ["renderer.script", "electron.windowControls"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for: " + what);
}

function overlayViewForWindow(win) {
  return win.contentView.children[0] || null;
}

function overlayTokenForWindow(win) {
  const rec = testing.windows().get(win.webContents.id);
  return rec && rec.windowControlsHost ? rec.windowControlsHost.token : null;
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  fakeWindows = new Map();
  nextContentsId = 1;
  nextOverlayId = 1000;
  pluginLogs = [];
  pageSnippets = [];
  overlaySnippets = [];
  overlayNavigations = [];
  loadDelayMs = 0;
  loadShouldReject = null;
  loadRejectOnce = false;
  omitWindowOpenHandler = false;
  FakeWebContentsView.created = [];
  FakeWebContentsView.throwOnConstruct = false;
  electron.WebContentsView = FakeWebContentsView;
  // Bun's mock.module snapshots the factory result at the first require after
  // each registration (later mutations are invisible through require.cache).
  // Re-register so the host's lazy require("electron") snapshots the object
  // WITH WebContentsView; without this, single-file runs mount against a stale
  // snapshot taken before beforeEach and fail with "no trusted view constructor".
  mock.module("electron", () => electron);
  testing.setWindowEnumerator(() => [...fakeWindows.values()]);
  testing.setWindowResolver((id) => fakeWindows.get(id) || null);
  runtime.start(electron.app, {
    runtimeLog: () => {},
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
  await sleep(0);
});

afterEach(() => {
  for (const key of testing.rendererPlugins().keys()) {
    try {
      testing.rendererPlugins().get(key).deactivate();
    } catch (_e) {
      /* best effort */
    }
  }
  testing.reset();
  electron.app.removeAllListeners();
  delete electron.WebContentsView;
  // Leave no stale snapshot behind for later files in the same process.
  mock.module("electron", () => electron);
});

function willNavigateEvent(overlayContents) {
  return { sender: overlayContents, preventDefault: () => {} };
}

// Real Electron `will-frame-navigate` details shape (single param, no
// sender — see electron.d.ts WebContentsWillFrameNavigateEventParams):
// url + frame role + preventDefault. Origin safety comes from the host
// registering the listener ONLY on the overlay WebContents.
function willFrameNavigateDetails(url, extra) {
  return {
    url,
    isMainFrame: true,
    preventDefault: () => {},
    ...(extra || {}),
  };
}

describe("window-controls pure module", () => {
  test("permission + scheme + bounds + safe prefs are fixed", () => {
    expect(wc.WINDOW_CONTROLS_PERMISSION).toBe("electron.windowControls");
    expect(wc.WINDOW_CONTROLS_SCHEME).toBe("tronhawk-wc");
    expect(wc.WINDOW_CONTROLS_VIEW_BOUNDS).toEqual({ x: 12, y: 12, width: 68, height: 24 });
    expect(wc.WINDOW_CONTROLS_SAFE_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  test("overlay HTML is fixed-style, token-bound, script-free", () => {
    const html = wc.windowControlsViewHtml("a".repeat(32));
    expect(html).toContain("data-action=\"close\"");
    expect(html).toContain("data-action=\"minimize\"");
    expect(html).toContain("data-action=\"toggleMaximize\"");
    expect(html).toContain("tronhawk-wc://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/close");
    // Every button opens in a new window context so clicks arrive at the
    // overlay's window-open handler (verified, then denied) on builds where
    // custom-scheme clicks emit no navigation event.
    expect(html.match(/<a target="_blank" href="tronhawk-wc:\/\/[^"]+\/(close|minimize|toggleMaximize)"/g)).toHaveLength(3);
    expect(html).toContain("#ff5f57");
    expect(html).toContain("#febc2e");
    expect(html).toContain("#28c840");
    // Chromeless: served document carries no pill background or scrollbars.
    expect(html).not.toContain("rgba(20,24,32,0.55)");
    expect(html).toContain("overflow:hidden");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("ipcRenderer");
    expect(html).not.toContain("require(");
  });

  test("per-window tokens are unguessable hex", () => {
    const a = wc.generateWindowControlsToken();
    const b = wc.generateWindowControlsToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("navigation parsing accepts only exact token/action shape", () => {
    const tok = "b".repeat(32);
    expect(wc.parseWindowControlsNavigation(`tronhawk-wc://${tok}/close`)).toEqual({
      token: tok,
      action: "close",
    });
    expect(wc.parseWindowControlsNavigation(`tronhawk-wc://${tok}/toggleMaximize`).action).toBe(
      "toggleMaximize",
    );
    expect(wc.parseWindowControlsNavigation(`tronhawk-wc://short/close`)).toBeNull();
    expect(wc.parseWindowControlsNavigation(`tronhawk-wc://${tok}/bogus`)).toBeNull();
    expect(wc.parseWindowControlsNavigation(`tronhawk-wc://${tok}/close?x=1`)).toBeNull();
    expect(wc.parseWindowControlsNavigation(`https://${tok}/close`)).toBeNull();
    expect(wc.parseWindowControlsNavigation("not a url")).toBeNull();
  });

  test("action validation + apply dispatch to the CURRENT window only", () => {
    expect(wc.isWindowControlsAction("minimize")).toBe(true);
    expect(wc.isWindowControlsAction("toggleMaximize")).toBe(true);
    expect(wc.isWindowControlsAction("close")).toBe(true);
    expect(wc.isWindowControlsAction("closeWindow")).toBe(false);
    expect(wc.applyWindowControlsAction(null, "close")).toBe(false);
    const calls = [];
    const win = {
      minimize: () => calls.push("minimize"),
      maximize: () => calls.push("maximize"),
      unmaximize: () => calls.push("unmaximize"),
      close: () => calls.push("close"),
      isMaximized: () => false,
    };
    expect(wc.applyWindowControlsAction(win, "minimize")).toBe(true);
    wc.applyWindowControlsAction(win, "toggleMaximize");
    expect(calls[calls.length - 1]).toBe("maximize");
    win.isMaximized = () => true;
    wc.applyWindowControlsAction(win, "toggleMaximize");
    expect(calls[calls.length - 1]).toBe("unmaximize");
  });

  test("implemented capability sets place windowControls at Level 2 (not dev-only)", () => {
    expect(testing.implementedLevelTwoCapabilities()).toContain("electron.windowControls");
    expect(testing.implementedLevelTwoDeveloperCapabilities()).toContain("electron.windowControls");
    expect(testing.implementedRendererCapabilities()).not.toContain("electron.windowControls");
  });
});

describe("ctx.windowControls trusted dispatch", () => {
  test("safe view config + real-click closed loop (minimize/toggle/close)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => {
          await ctx.windowControls.mount();
          ctx.logger.info("WC-READY");
        },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    // Safe configuration: isolated, no Node, sandboxed, no preload.
    expect(FakeWebContentsView.created).toHaveLength(1);
    const opts = FakeWebContentsView.created[0].options;
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.preload).toBeUndefined();
    // Exact content-sized geometry + explicit transparent background: no
    // transparent margin around the controls to swallow page clicks.
    expect(FakeWebContentsView.created[0].bounds).toEqual({ x: 12, y: 12, width: 68, height: 24 });
    expect(FakeWebContentsView.created[0].backgroundColor).toBe("#00000000");
    // No page-DOM injection for the overlay (trusted view only).
    expect(pageSnippets.join("\n")).not.toContain("traffic-lights");
    const view = overlayViewForWindow(win);
    expect(view).not.toBeNull();
    const token = overlayTokenForWindow(win);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const oc = view.webContents;
    // Integration: the document the host actually loaded drives dispatch. Decode
    // the served data-URL and click its REAL minimize href — this proves the
    // served-link format and the interceptor agree end to end (not just that a
    // hand-built URL string is accepted).
    expect(overlayNavigations).toHaveLength(1);
    const servedPrefix = "data:text/html;charset=utf-8,";
    expect(overlayNavigations[0].startsWith(servedPrefix)).toBe(true);
    const servedHtml = decodeURIComponent(overlayNavigations[0].slice(servedPrefix.length));
    const servedMinimize = servedHtml.match(/href="(tronhawk-wc:\/\/[0-9a-f]{32}\/minimize)"/);
    expect(servedMinimize).not.toBeNull();
    expect(servedMinimize[1]).toBe(`tronhawk-wc://${token}/minimize`);
    // Every overlay navigation is blocked first (overlay never leaves its
    // trusted document), then dispatched on sender + token match.
    let prevented = 0;
    const click = (url) =>
      oc.emit("will-navigate", { sender: oc, preventDefault: () => { prevented++; } }, url);
    click(servedMinimize[1]);
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    click(`tronhawk-wc://${token}/toggleMaximize`);
    await waitFor(() => win.calls.some((c) => c[0] === "maximize"), "maximize dispatched");
    win._maximized = true;
    click(`tronhawk-wc://${token}/toggleMaximize`);
    await waitFor(() => win.calls.some((c) => c[0] === "unmaximize"), "unmaximize dispatched");
    click(`tronhawk-wc://${token}/close`);
    await waitFor(() => win.calls.some((c) => c[0] === "close"), "close dispatched");
    expect(prevented).toBe(4);
  });

  test("will-frame-navigate closed loop (details-object signature, Electron 43 path)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => {
          await ctx.windowControls.mount();
          ctx.logger.info("WC-READY");
        },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const view = overlayViewForWindow(win);
    const oc = view.webContents;
    const token = overlayTokenForWindow(win);
    expect(oc.listenerCount("will-frame-navigate")).toBe(1);
    // Real single-param details: blocked first (registration boundary proves
    // overlay origin), then dispatched on frame role + token match.
    let prevented = 0;
    const clickFrame = (action, extra) => {
      const details = willFrameNavigateDetails(`tronhawk-wc://${token}/${action}`, {
        preventDefault: () => { prevented++; },
        ...(extra || {}),
      });
      oc.emit("will-frame-navigate", details);
    };
    clickFrame("minimize");
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    clickFrame("toggleMaximize");
    await waitFor(() => win.calls.some((c) => c[0] === "maximize"), "maximize dispatched");
    win._maximized = true;
    clickFrame("toggleMaximize");
    await waitFor(
      () => win.calls.some((c) => c[0] === "unmaximize"),
      "unmaximize dispatched",
    );
    clickFrame("close");
    await waitFor(() => win.calls.some((c) => c[0] === "close"), "close dispatched");
    expect(prevented).toBe(4);
  });

  test("will-frame-navigate ignores any positional second arg (single-param API)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    // The real API passes the URL only on details: a legacy-style positional
    // URL with no details.url must NOT dispatch (blocked, but ignored).
    let prevented = 0;
    const before = win.calls.length;
    oc.emit(
      "will-frame-navigate",
      { isMainFrame: true, preventDefault: () => { prevented++; } },
      `tronhawk-wc://${token}/minimize`,
    );
    await sleep(30);
    expect(win.calls.length).toBe(before);
    expect(prevented).toBe(1);
  });

  test("one click emitting both events dispatches exactly once", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    let prevented = 0;
    const prevent = () => { prevented++; };
    // Same user click observed through both events (either order): the first
    // sighting dispatches, the twin is skipped.
    oc.emit("will-navigate", { sender: oc, preventDefault: prevent }, `tronhawk-wc://${token}/minimize`);
    oc.emit("will-frame-navigate", { url: `tronhawk-wc://${token}/minimize`, isMainFrame: true, preventDefault: prevent });
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    await sleep(50);
    expect(win.calls.filter((c) => c[0] === "minimize")).toHaveLength(1);
    expect(prevented).toBe(2);
    // Reversed order behaves the same (frame first, then navigate).
    oc.emit("will-frame-navigate", { url: `tronhawk-wc://${token}/close`, isMainFrame: true, preventDefault: prevent });
    oc.emit("will-navigate", { sender: oc, preventDefault: prevent }, `tronhawk-wc://${token}/close`);
    await waitFor(() => win.calls.some((c) => c[0] === "close"), "close dispatched");
    await sleep(50);
    expect(win.calls.filter((c) => c[0] === "close")).toHaveLength(1);
    expect(prevented).toBe(4);
  });

  test("repeats through the same event always dispatch (no self-dedup)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    const clickFrame = (action) =>
      oc.emit(
        "will-frame-navigate",
        { url: `tronhawk-wc://${token}/${action}`, isMainFrame: true, preventDefault: () => {} },
      );
    // Rapid maximize-then-restore through one event kind stays live.
    clickFrame("toggleMaximize");
    await waitFor(() => win.calls.some((c) => c[0] === "maximize"), "maximize dispatched");
    win._maximized = true;
    clickFrame("toggleMaximize");
    await waitFor(() => win.calls.some((c) => c[0] === "unmaximize"), "unmaximize dispatched");
  });

  test("window-open closed loop: verified, dispatched, always denied", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    // Installed on the overlay only — the page exposes no such surface.
    expect(typeof oc.setWindowOpenHandler).toBe("function");
    expect(typeof contents.setWindowOpenHandler).toBe("undefined");
    const open = (action) => oc.openWindow({ url: `tronhawk-wc://${token}/${action}` });
    expect(open("minimize")).toEqual({ action: "deny" });
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    expect(open("toggleMaximize")).toEqual({ action: "deny" });
    await waitFor(() => win.calls.some((c) => c[0] === "maximize"), "maximize dispatched");
    win._maximized = true;
    expect(open("toggleMaximize")).toEqual({ action: "deny" });
    await waitFor(() => win.calls.some((c) => c[0] === "unmaximize"), "unmaximize dispatched");
    expect(open("close")).toEqual({ action: "deny" });
    await waitFor(() => win.calls.some((c) => c[0] === "close"), "close dispatched");
  });

  test("window-open denies everything it cannot verify, without dispatch", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    const before = win.calls.length;
    // Forged token, bogus action, missing/empty details: all denied, none
    // dispatched (the overlay still never opens a window).
    expect(oc.openWindow({ url: `tronhawk-wc://${"0".repeat(32)}/close` })).toEqual({ action: "deny" });
    expect(oc.openWindow({ url: `tronhawk-wc://${token}/bogus` })).toEqual({ action: "deny" });
    expect(oc.openWindow({})).toEqual({ action: "deny" });
    expect(oc.openWindow()).toEqual({ action: "deny" });
    expect(oc.openWindow({ url: "https://example.invalid/" })).toEqual({ action: "deny" });
    await sleep(30);
    expect(win.calls.length).toBe(before);
    expect(pluginMessages(PID, "warn", "bad token")).toHaveLength(1);
  });

  test("window-open + navigation twin for one click dispatches once", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    const url = `tronhawk-wc://${token}/minimize`;
    expect(oc.openWindow({ url })).toEqual({ action: "deny" });
    // A late navigation twin of the same click is skipped.
    oc.emit("will-navigate", { sender: oc, preventDefault: () => {} }, url);
    oc.emit("will-frame-navigate", { url, isMainFrame: true, preventDefault: () => {} });
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    await sleep(50);
    expect(win.calls.filter((c) => c[0] === "minimize")).toHaveLength(1);
  });

  test("mount without window-open API falls back to the navigation path", async () => {
    omitWindowOpenHandler = true;
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const oc = overlayViewForWindow(win).webContents;
    const token = overlayTokenForWindow(win);
    expect(typeof oc.setWindowOpenHandler).toBe("undefined");
    let prevented = 0;
    oc.emit(
      "will-navigate",
      { sender: oc, preventDefault: () => { prevented++; } },
      `tronhawk-wc://${token}/minimize`,
    );
    await waitFor(() => win.calls.some((c) => c[0] === "minimize"), "minimize dispatched");
    expect(prevented).toBe(1);
  });

  test("will-frame-navigate forgeries cannot reach window ops", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const token = overlayTokenForWindow(win);
    const oc = overlayViewForWindow(win).webContents;
    const before = win.calls.length;
    // The host listens on the overlay only (registration-source boundary):
    // page frame-navigations to the token URL are never observed.
    contents.emit("will-frame-navigate", willFrameNavigateDetails(`tronhawk-wc://${token}/close`));
    expect(contents.listenerCount("will-frame-navigate")).toBe(0);
    // Missing details are ignored without side effects (nothing to block).
    oc.emit("will-frame-navigate", null);
    oc.emit("will-frame-navigate", undefined);
    // Subframe navigations are blocked but never dispatched (the overlay has
    // no subframes by construction).
    let subPrevented = 0;
    oc.emit(
      "will-frame-navigate",
      { url: `tronhawk-wc://${token}/close`, isMainFrame: false, preventDefault: () => { subPrevented++; } },
    );
    // Bad token / bogus action / missing URL are blocked first, then rejected.
    let rejectedPrevented = 0;
    const rejected = (details) =>
      oc.emit(
        "will-frame-navigate",
        { isMainFrame: true, preventDefault: () => { rejectedPrevented++; }, ...details },
      );
    rejected({ url: `tronhawk-wc://${"0".repeat(32)}/close` });
    rejected({ url: `tronhawk-wc://${token}/bogus` });
    rejected({});
    await sleep(30);
    expect(win.calls.length).toBe(before);
    expect(subPrevented).toBe(1);
    expect(rejectedPrevented).toBe(3);
  });

  test("unmount removes both navigation listeners", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const view = overlayViewForWindow(win);
    const oc = view.webContents;
    expect(oc.listenerCount("will-navigate")).toBe(1);
    expect(oc.listenerCount("will-frame-navigate")).toBe(1);
    applyPlan(planFor("r2", []));
    await waitFor(() => testing.rendererPlugins().size === 0, "revoked");
    await sleep(20);
    expect(win.contentView.children).toHaveLength(0);
    expect(oc.listenerCount("will-navigate")).toBe(0);
    expect(oc.listenerCount("will-frame-navigate")).toBe(0);
  });

  test("overlay view is exactly content-sized with explicit transparency", () => {
    // CSS contract: border-box 12px circles (1px ring inside 12px), chromeless
    // transparent content-sized document, overflow clipped (never scrollbars).
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).toContain("box-sizing:border-box");
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).toContain("background:transparent");
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).toContain("display:inline-block");
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).toContain("overflow:hidden");
    // No independent pill base: no container background, no rounded box.
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).not.toContain("rgba(20,24,32,0.55)");
    expect(wc.WINDOW_CONTROLS_VIEW_CSS).not.toContain("border-radius:10px");
    // Bounds match the painted content exactly: 8 + 3*12 + 2*8 + 8 = 68 wide,
    // 6 + 12 + 6 = 24 tall — no painted pixel outside, no transparent margin
    // to swallow page clicks, no overflow to scroll.
    expect(wc.WINDOW_CONTROLS_VIEW_BOUNDS).toEqual({ x: 12, y: 12, width: 68, height: 24 });
  });

  test("overlay webContents never enters target discovery (no recursion)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const view = overlayViewForWindow(win);
    const oc = view.webContents;
    // The overlay announced itself synchronously as getType() === "window"...
    expect(oc.getType()).toBe("window");
    expect(FakeWebContentsView.created).toHaveLength(1);
    // ...and, like on the real platform, its data-URL document finishes
    // loading afterwards. Neither event may admit it to target discovery.
    oc.emit("did-finish-load");
    await sleep(50); // any recursion would have built nested views by now
    // ...yet never became a target: no window record, no plugins, no nested overlay.
    expect(testing.windows().size).toBe(1);
    expect(testing.windows().has(oc.id)).toBe(false);
    for (const key of testing.rendererPlugins().keys()) {
      expect(key.endsWith("@" + oc.id)).toBe(false);
    }
    expect(FakeWebContentsView.created).toHaveLength(1);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(1);
  });

  test("windowControls is absent without the electron.windowControls grant", async () => {
    const src = `module.exports = { activate: (ctx) => { ctx.logger.info("WC-TYPEOF:" + (typeof ctx.windowControls)); } };`;
    loadOne({ grants: ["renderer.script"], rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-TYPEOF").length > 0, "plugin loaded");
    expect(pluginMessages(PID, "info", "WC-TYPEOF")[0][2]).toBe("WC-TYPEOF:undefined");
    expect(FakeWebContentsView.created).toHaveLength(0);
  });

  test("windowControls-only grant does NOT execute renderer (additional-only)", async () => {
    const src = `module.exports = { activate: (ctx) => { ctx.logger.info("WC-RAN"); } };`;
    loadOne({ grants: ["electron.windowControls"], rendererSource: src });
    await sleep(80);
    expect(pluginMessages(PID, "info", "WC-RAN")).toHaveLength(0);
    expect(testing.rendererPlugins().size).toBe(0);
    expect(FakeWebContentsView.created).toHaveLength(0);
  });

  test("mount/unmount with extra args warn without host calls", async () => {
    const src = `
      module.exports = {
        activate: (ctx) => {
          ctx.logger.info("WC-MOUNT-EXTRA:" + String(ctx.windowControls.mount(123)));
          ctx.logger.info("WC-UNMOUNT-EXTRA:" + String(ctx.windowControls.unmount("x")));
        },
      };
    `;
    loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-UNMOUNT-EXTRA").length > 0, "extra handling");
    expect(pluginMessages(PID, "info", "WC-MOUNT-EXTRA")[0][2]).toBe("WC-MOUNT-EXTRA:undefined");
    expect(FakeWebContentsView.created).toHaveLength(0);
    expect(pluginMessages(PID, "warn", "takes no arguments").length).toBeGreaterThan(0);
  });

  test("mount fails closed without a trusted view constructor", async () => {
    delete electron.WebContentsView;
    // Re-snapshot (see beforeEach): the host must observe the deletion.
    mock.module("electron", () => electron);
    const src = `
      module.exports = {
        activate: async (ctx) => {
          try { await ctx.windowControls.mount(); ctx.logger.info("WC-UNEXPECTED-RESOLVE"); }
          catch (e) { ctx.logger.info("WC-MOUNT-REJECTED:" + String(e && e.message ? e.message : e)); }
        },
      };
    `;
    loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-MOUNT-REJECTED").length > 0, "rejected");
    const rec = testing.windows().get(1);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
  });

  test("page forgeries cannot close the window", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const token = overlayTokenForWindow(win);
    const view = overlayViewForWindow(win);
    const oc = view.webContents;
    const before = win.calls.length;
    // No page IPC channel exists: host listens nowhere for it.
    contents.emit("ipc-message", {}, "tronhawk-window-controls", "close");
    // Main-page navigation to the token URL is never listened on.
    contents.emit("will-navigate", willNavigateEvent(contents), `tronhawk-wc://${token}/close`);
    // Missing event / missing sender is ignored without side effects (strict
    // fail-closed sender check): never dispatched, never preventDefaulted.
    let foreignPrevented = 0;
    const foreignPrevent = () => { foreignPrevented++; };
    oc.emit("will-navigate", null, `tronhawk-wc://${token}/close`);
    oc.emit("will-navigate", undefined, `tronhawk-wc://${token}/close`);
    oc.emit("will-navigate", {}, `tronhawk-wc://${token}/close`);
    oc.emit("will-navigate", { sender: null, preventDefault: foreignPrevent }, `tronhawk-wc://${token}/close`);
    // Overlay navigation with a guessed token is rejected (but still blocked
    // first so the overlay never leaves its trusted document).
    let rejectedPrevented = 0;
    const rejectedNav = (sender, url) =>
      oc.emit("will-navigate", { sender, preventDefault: () => { rejectedPrevented++; } }, url);
    rejectedNav(oc, `tronhawk-wc://${"0".repeat(32)}/close`);
    // Overlay navigation with a bogus action is rejected.
    rejectedNav(oc, `tronhawk-wc://${token}/bogus`);
    expect(rejectedPrevented).toBe(2);
    // Wrong sender is rejected without side effects.
    oc.emit("will-navigate", willNavigateEvent(contents), `tronhawk-wc://${token}/close`);
    await sleep(30);
    expect(win.calls.length).toBe(before);
    expect(foreignPrevented).toBe(0);
  });

  test("maximize/unmaximize syncs the trusted overlay", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const before = overlaySnippets.length;
    win._maximized = true;
    win.emit("maximize");
    await waitFor(
      () => overlaySnippets.slice(before).some((s) => s.includes("Restore")),
      "maximize sync",
    );
    win._maximized = false;
    win.emit("unmaximize");
    await waitFor(
      () => overlaySnippets.slice(before).some((s) => s.includes("Maximize")),
      "unmaximize sync",
    );
  });
});

describe("ctx.windowControls ownership + cleanup", () => {
  test("dual-plugin refcount shares one view; last leave removes everything", async () => {
    const srcA = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("A-READY"); },
      };
    `;
    const srcB = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("B-READY"); },
      };
    `;
    const { win } = loadPlugins({
      plugins: [pluginEntry(PID, WC_GRANTS, srcA), pluginEntry(PID2, WC_GRANTS, srcB)],
    });
    await waitFor(() => pluginMessages(PID, "info", "A-READY").length > 0, "A mounted");
    await waitFor(() => pluginMessages(PID2, "info", "B-READY").length > 0, "B mounted");
    expect(FakeWebContentsView.created).toHaveLength(1);
    expect(win.contentView.children).toHaveLength(1);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(2);
    // Revoke A only: view persists for B.
    applyPlan(planFor("r2", [pluginEntry(PID2, WC_GRANTS, srcB)]));
    await sleep(60);
    expect(win.contentView.children).toHaveLength(1);
    expect(rec.windowControlsHost.owners.size).toBe(1);
    // Revoke B: view, listeners, and token are all removed together.
    const oc = overlayViewForWindow(win).webContents;
    applyPlan(planFor("r3", []));
    await waitFor(() => testing.rendererPlugins().size === 0, "all revoked");
    expect(win.contentView.children).toHaveLength(0);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    expect(rec.windowControlsHost.token).toBeNull();
    expect(oc.listenerCount("will-navigate")).toBe(0);
    expect(win.listenerCount("maximize")).toBe(0);
    expect(win.listenerCount("unmaximize")).toBe(0);
  });

  test("pending mount revoked before load undoes itself with no residue", async () => {
    loadDelayMs = 120;
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await sleep(20); // mount pending (loadURL in flight)
    applyPlan(planFor("r2", [])); // revoke before load resolves
    await waitFor(() => testing.rendererPlugins().size === 0, "revoked");
    await sleep(200); // let the late load resolve
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    expect(win.contentView.children).toHaveLength(0);
    expect(pluginMessages(PID, "info", "WC-READY")).toHaveLength(0);
  });

  test("mount then immediate unmount leaves zero residue", async () => {
    loadDelayMs = 80;
    const src = `
      module.exports = {
        activate: (ctx) => {
          ctx.windowControls.mount();
          ctx.windowControls.unmount();
          ctx.logger.info("WC-DONE");
        },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-DONE").length > 0, "done");
    await sleep(160);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    expect(win.contentView.children).toHaveLength(0);
  });

  test("navigation tears down the old instance and mounts a fresh view", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    expect(FakeWebContentsView.created).toHaveLength(1);
    expect(win.contentView.children).toHaveLength(1);
    pluginLogs = [];
    contents.emit("did-finish-load");
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "remounted");
    expect(FakeWebContentsView.created.length).toBeGreaterThanOrEqual(2);
    expect(win.contentView.children).toHaveLength(1);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(1);
  });

  test("failed load registers no owner and rejects", async () => {
    loadShouldReject = "overlay load failed";
    const src = `
      module.exports = {
        activate: async (ctx) => {
          try { await ctx.windowControls.mount(); ctx.logger.info("WC-UNEXPECTED"); }
          catch (e) { ctx.logger.info("WC-FAILED"); }
        },
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-FAILED").length > 0, "failed");
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    expect(win.contentView.children).toHaveLength(0);
  });

  test("concurrent mounts share one load; load failure rejects every waiter and clears all", async () => {
    loadDelayMs = 120;
    loadShouldReject = "overlay load failed";
    const srcA = `
      module.exports = {
        activate: async (ctx) => {
          try { await ctx.windowControls.mount(); ctx.logger.info("A-READY"); }
          catch (e) { ctx.logger.info("A-FAILED"); }
        },
      };
    `;
    const srcB = `
      module.exports = {
        activate: async (ctx) => {
          try { await ctx.windowControls.mount(); ctx.logger.info("B-READY"); }
          catch (e) { ctx.logger.info("B-FAILED"); }
        },
      };
    `;
    const { win } = loadPlugins({
      plugins: [pluginEntry(PID, WC_GRANTS, srcA), pluginEntry(PID2, WC_GRANTS, srcB)],
    });
    await sleep(30); // both mounts joined the same in-flight load
    expect(FakeWebContentsView.created).toHaveLength(1); // one view, one load
    await waitFor(() => pluginMessages(PID, "info", "A-FAILED").length > 0, "A rejected");
    await waitFor(() => pluginMessages(PID2, "info", "B-FAILED").length > 0, "B rejected");
    expect(pluginMessages(PID, "info", "A-READY")).toHaveLength(0);
    expect(pluginMessages(PID2, "info", "B-READY")).toHaveLength(0);
    // Still exactly one construction, and the slot is fully cleared.
    expect(FakeWebContentsView.created).toHaveLength(1);
    const oc = FakeWebContentsView.created[0].webContents;
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    expect(rec.windowControlsHost.token).toBeNull();
    expect(win.contentView.children).toHaveLength(0);
    expect(oc.listenerCount("will-navigate")).toBe(0);
    expect(win.listenerCount("maximize")).toBe(0);
    expect(win.listenerCount("unmaximize")).toBe(0);
  });

  test("stale load settle after navigation destroys only its own view", async () => {
    loadDelayMs = 150;
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await sleep(30); // old load in flight
    expect(FakeWebContentsView.created).toHaveLength(1);
    const oldView = FakeWebContentsView.created[0];
    pluginLogs = [];
    contents.emit("did-finish-load"); // navigation: old instance revoked, old view torn down, new mount pending
    await waitFor(() => FakeWebContentsView.created.length >= 2, "new view constructed");
    const newView = FakeWebContentsView.created[1];
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "new mount resolved");
    await sleep(250); // old load resolves late (stale)
    // The new generation is untouched: exactly the new view attached, owned, live.
    expect(win.contentView.children).toHaveLength(1);
    expect(win.contentView.children[0]).toBe(newView);
    expect(oldView.webContents.isDestroyed()).toBe(true);
    expect(newView.webContents.isDestroyed()).toBe(false);
    expect(newView.webContents.listenerCount("will-navigate")).toBe(1);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(1);
    expect(rec.windowControlsHost.view).toBe(newView);
  });

  test("stale load failure after navigation cannot touch the new view", async () => {
    loadDelayMs = 150;
    loadRejectOnce = true; // only the OLD load fails; the new one resolves
    const src = `
      module.exports = {
        activate: async (ctx) => {
          try { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); }
          catch (e) { ctx.logger.info("WC-FAILED"); }
        },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await sleep(30); // old load in flight
    expect(FakeWebContentsView.created).toHaveLength(1);
    const oldView = FakeWebContentsView.created[0];
    pluginLogs = [];
    contents.emit("did-finish-load"); // navigation: new mount pending on a fresh view
    await waitFor(() => FakeWebContentsView.created.length >= 2, "new view constructed");
    const newView = FakeWebContentsView.created[1];
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "new mount resolved");
    await sleep(250); // old load rejects late (stale)
    expect(pluginMessages(PID, "info", "WC-FAILED")).toHaveLength(0);
    expect(win.contentView.children).toHaveLength(1);
    expect(win.contentView.children[0]).toBe(newView);
    expect(newView.webContents.isDestroyed()).toBe(false);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(1);
    expect(rec.windowControlsHost.view).toBe(newView);
  });

  test("deactivate removes view + listeners (zero residue, page untouched)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
        deactivate: async (ctx) => {},
      };
    `;
    const { win } = loadOne({ grants: WC_GRANTS, rendererSource: src, revision: "r1" });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    const view = overlayViewForWindow(win);
    const oc = view.webContents;
    applyPlan(planFor("r2", []));
    await waitFor(() => testing.rendererPlugins().size === 0, "revoked");
    await sleep(20);
    expect(win.contentView.children).toHaveLength(0);
    expect(oc.listenerCount("will-navigate")).toBe(0);
    expect(win.listenerCount("maximize")).toBe(0);
    expect(win.listenerCount("unmaximize")).toBe(0);
    const rec = testing.windows().get(win.webContents.id);
    expect(rec.windowControlsHost.owners.size).toBe(0);
    expect(rec.windowControlsHost.view).toBeNull();
    // The target page was never touched: no cleanup snippet ever ran in it.
    expect(pageSnippets).toHaveLength(0);
  });

  test("window destroy quenches without hanging (cleanup runs, queue drains)", async () => {
    const src = `
      module.exports = {
        activate: async (ctx) => { await ctx.windowControls.mount(); ctx.logger.info("WC-READY"); },
      };
    `;
    const { contents, win } = loadOne({ grants: WC_GRANTS, rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "WC-READY").length > 0, "mounted");
    contents.emit("destroyed");
    await sleep(50);
    expect(testing.rendererPlugins().size).toBe(0);
    expect(win.contentView.children).toHaveLength(0);
  });
});

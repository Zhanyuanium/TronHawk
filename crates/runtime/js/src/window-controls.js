// Host-hosted declarative window-controls overlay (electron.windowControls).
//
// The plugin may only `mount`/`unmount` a fixed-style traffic-light cluster.
// The host renders the buttons in an INDEPENDENT, host-controlled
// WebContentsView (separate WebContents with safe webPreferences, data-URL
// HTML, no <script>, no preload) and binds real user clicks to the CURRENT
// BrowserWindow's `minimize` / toggle-maximize / `close` via the overlay
// view's `setWindowOpenHandler` (links carry `target="_blank"`, so every
// click — left, middle, keyboard-activated — arrives as a window-open request
// the host verifies then denies) plus `will-navigate` / `will-frame-navigate`
// interception as the fallback path on builds that navigate custom-scheme
// link clicks instead (strict sender identity plus per-window-token-verified,
// twin-dedup across all paths, deny/block-before-parse so the overlay never
// leaves its trusted data-URL document). Rationale: on newer Electron,
// custom-scheme link clicks from a `data:` document produce NO navigation
// event at all (observed on 43: no will-*, no did-start-navigation), so a
// navigation-only interception leaves the lights visible but dead. The target
// page's WebContents is NEVER injected
// with overlay DOM or click-to-IPC JavaScript: the old page
// `require("electron").ipcRenderer` dependency is deleted. The page cannot
// forge clicks (different WebContents, unguessable per-window token, no page
// reference to the overlay), cannot call the host channel directly, and the
// implementation does not depend on the target app's own preload.
//
// Fail-closed: when a trusted view cannot be built (no WebContentsView, no
// contentView seam, no live BrowserWindow, load failure), `mount()` rejects
// and registers no owner.
//
// This module is pure host template + pure helpers (no Electron require, no
// QuickJS). `src/index.js` owns the QuickJS binding (`buildWindowControlsApi`),
// the per-window refcount with per-instance tokens, navigation dispatch, and
// cleanup wiring. Unit tests cover both this module and the binding in
// `src/window-controls.test.js`.
//
// Deliberately NOT an ADAPTERS generic adapter and never touches `wco.js`:
// adapters rewrite future `new BrowserWindow(opts)`; this overlay manages one
// trusted view on the CURRENT window.

const WINDOW_CONTROLS_PERMISSION = "electron.windowControls";
// Custom scheme for overlay button clicks. Overlay links point at
// `tronhawk-wc://<per-window-token>/<action>`; the host intercepts
// `will-navigate` on the OVERLAY view only, verifies sender + token, then
// dispatches. The main page is never listened on, so page forgeries
// (`ipc-message`, `fetch`, forged navigations on the page) never reach window
// ops.
const WINDOW_CONTROLS_SCHEME = "tronhawk-wc";
// Fixed overlay geometry inside the parent window (device-independent px).
// EXACT content size — the view rect must not exceed the painted controls, or
// the transparent margin would swallow clicks meant for the page beneath.
// Arithmetic (all px, no text, deterministic): width = 8 (body pad) + 3*12
// (border-box circles) + 2*8 (gaps) + 8 (body pad) = 68; height = 6 + 12 + 6
// = 24. Anchors use box-sizing:border-box so the 1px ring stays inside 12px.
const WINDOW_CONTROLS_VIEW_BOUNDS = { x: 12, y: 12, width: 68, height: 24 };
// Safe webPreferences for the trusted overlay view. Mirrored by the host at
// creation time; tests assert the exact flags (contextIsolation on,
// nodeIntegration off, sandbox on, no preload).
const WINDOW_CONTROLS_SAFE_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  enableWebSQL: false,
});

// The overlay never touches target page DOM: v1 was never published, so there
// is no migration residue to clean and no page cleanup path exists anywhere.

// Fixed overlay CSS (embedded in the trusted view HTML, never in the page).
// macOS-style chromeless lights: the document is fully transparent
// (html/body, no pill background, no rounded container) and content-sized
// (inline-block body), with overflow clipped (never scrollbars) — together
// with the exact view bounds above, no painted pixel and no transparent
// hit-area extends past the three controls.
// Exact-size arithmetic (px, deterministic; `box-sizing:border-box` keeps the
// 1px ring INSIDE the 12px circle, so content == view exactly):
// width = 8 (body pad) + 3*12 (circles) + 2*8 (gaps) + 8 (body pad) = 68;
// height = 6 (body pad) + 12 (circles) + 6 (body pad) = 24.
const WINDOW_CONTROLS_VIEW_CSS = [
  "html,body{margin:0;padding:0;background:transparent;overflow:hidden;}",
  "body{display:inline-block;padding:6px 8px;background:transparent;}",
  ".wc{display:flex;gap:8px;align-items:center;-webkit-app-region:no-drag;user-select:none;}",
  ".wc a{display:block;box-sizing:border-box;width:12px;height:12px;border-radius:50%;border:1px solid rgba(0,0,0,0.25);text-decoration:none;}",
  '.wc a[data-action="close"]{background:#ff5f57;}',
  '.wc a[data-action="minimize"]{background:#febc2e;}',
  '.wc a[data-action="toggleMaximize"]{background:#28c840;}',
  ".wc a:focus-visible{outline:2px solid #fff;outline-offset:2px;}",
].join("");

// Fixed overlay HTML for the trusted view. `token` is the host-generated
// per-window unguessable token (never placed in the main page). No <script>:
// buttons are plain links with `target="_blank"`; clicks become window-open
// requests the host verifies then denies (plus a navigation event on builds
// that navigate instead). `encodeHtml` is internal (token is hex, actions are
// fixed).
function windowControlsViewHtml(token) {
  const t = String(token || "");
  const link = (action, label) =>
    '<a target="_blank" href="' +
    WINDOW_CONTROLS_SCHEME +
    "://" +
    t +
    "/" +
    action +
    '" data-action="' +
    action +
    '" aria-label="' +
    label +
    '" title="' +
    label +
    '"></a>';
  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
    WINDOW_CONTROLS_VIEW_CSS +
    "</style></head><body><div class=\"wc\" role=\"group\" aria-label=\"Window controls\">" +
    link("close", "Close") +
    link("minimize", "Minimize") +
    link("toggleMaximize", "Maximize") +
    "</div></body></html>"
  );
}

function windowControlsViewDataUrl(token) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(windowControlsViewHtml(token))
  );
}

// Per-window unguessable token (128-bit hex). The host generates one per
// window on first mount; overlay URLs embed it; navigation dispatch verifies
// it. The main page never sees it (separate WebContents, no page injection).
function generateWindowControlsToken(randomBytes) {
  const rand =
    typeof randomBytes === "function"
      ? randomBytes
      : () => {
          const c = require("crypto");
          return c.randomBytes(16);
        };
  return Buffer.from(rand(16)).toString("hex");
}

// Parse an overlay navigation URL. Returns `{ token, action }` on exact
// `tronhawk-wc://<token>/<action>` shape with a known action, else null.
// Never throws (fail-closed callers ignore null).
function parseWindowControlsNavigation(url) {
  if (typeof url !== "string" || url.length > 512) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return null;
  }
  if (parsed.protocol !== WINDOW_CONTROLS_SCHEME + ":") return null;
  const token = parsed.hostname || "";
  const action = (parsed.pathname || "").replace(/^\/+/, "");
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  if (!isWindowControlsAction(action)) return null;
  // Reject URLs with unexpected extras (query/hash/credentials/ports): the
  // overlay emits bare `<scheme>://<token>/<action>` only.
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port)
    return null;
  return { token, action };
}

// Host-owned state-sync snippet for the TRUSTED overlay view (never the
// page). `isMaximized` is a host boolean from the CURRENT BrowserWindow;
// the snippet only flips the maximize button's label/title. Safe to run via
// `overlayWebContents.executeJavaScript`: the target is the host's own view,
// not attacker page content.
function windowControlsSyncSnippet(isMaximized) {
  const label = isMaximized ? "Restore" : "Maximize";
  return (
    "(function(){try{" +
    'var b=document.querySelector(\'a[data-action="toggleMaximize"]\');' +
    "if(!b)return \"absent\";" +
    "b.setAttribute(\"aria-label\"," +
    JSON.stringify(label) +
    ");b.title=" +
    JSON.stringify(label) +
    ";" +
    'return "synced";}catch(e){return "failed";}})()'
  );
}

function isWindowControlsAction(value) {
  return value === "minimize" || value === "toggleMaximize" || value === "close";
}

// Bind the CURRENT BrowserWindow to one overlay action. `win` is host-
// resolved (never plugin-supplied). Returns true when the action was
// dispatched, false when the window or action is unknown. Never throws.
function applyWindowControlsAction(win, action) {
  if (!win || !isWindowControlsAction(action)) return false;
  try {
    if (action === "minimize") {
      if (typeof win.minimize === "function") win.minimize();
      return true;
    }
    if (action === "toggleMaximize") {
      const maximized =
        typeof win.isMaximized === "function" ? !!win.isMaximized() : false;
      if (maximized) {
        if (typeof win.unmaximize === "function") win.unmaximize();
      } else if (typeof win.maximize === "function") {
        win.maximize();
      }
      return true;
    }
    if (action === "close") {
      if (typeof win.close === "function") win.close();
      return true;
    }
  } catch (_e) {
    return false;
  }
  return false;
}

module.exports = {
  WINDOW_CONTROLS_PERMISSION,
  WINDOW_CONTROLS_SCHEME,
  WINDOW_CONTROLS_VIEW_BOUNDS,
  WINDOW_CONTROLS_SAFE_PREFERENCES,
  WINDOW_CONTROLS_VIEW_CSS,
  windowControlsViewHtml,
  windowControlsViewDataUrl,
  generateWindowControlsToken,
  parseWindowControlsNavigation,
  windowControlsSyncSnippet,
  isWindowControlsAction,
  applyWindowControlsAction,
};

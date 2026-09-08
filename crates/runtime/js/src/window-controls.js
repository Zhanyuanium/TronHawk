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
// link clicks instead (registration-source boundary plus
// per-window-token-verified, twin-dedup across all paths, deny/block-before-parse so the overlay never
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
// `will-navigate` on the OVERLAY view only (registration-source boundary),
// verifies the per-window token, then dispatches. The main page is never listened on, so page forgeries
// (`ipc-message`, `fetch`, forged navigations on the page) never reach window
// ops.
const WINDOW_CONTROLS_SCHEME = "tronhawk-wc";
// Declarative overlay geometry. ALL values are CSS px (DIP): the host never
// converts pixels, reads devicePixelRatio / scaleFactor, or measures
// screens, windows, or viewports — every size comes from the normalized
// plugin config below. No automatic display adaptation; physical pixels are
// never taken as CSS px (at DPR=2, 14 CSS = 28 physical).
// Sole table (DIP/CSS px): light diameter d=14, pitch p=24, cell 24x24,
// light inset (24-14)/2=5, visual gap p-d=10; region height H defaults 30,
// clamped 30..64; vertical margin m=(H-24)/2 centers the 24px cells in the
// H-tall view; view origin x = m+L where L is the left adjustment below
// (default 0, clamped 0..256) — default H=30 gives m=3, x=3; H=40 gives
// m=8, x=8. View bounds are 72xH at (m+L, 0) — default (3,0,72,30).
const WINDOW_CONTROLS_LIGHT_DIAMETER = 14;
const WINDOW_CONTROLS_CELL_SIZE = 24;
const WINDOW_CONTROLS_LIGHT_PITCH = 24;
const WINDOW_CONTROLS_LIGHT_GAP = 10;
const WINDOW_CONTROLS_LIGHT_INSET = 5;
const WINDOW_CONTROLS_REGION_HEIGHT_MIN = 30;
const WINDOW_CONTROLS_REGION_HEIGHT_MAX = 64;
const WINDOW_CONTROLS_REGION_HEIGHT_DEFAULT = 30;
const WINDOW_CONTROLS_LEFT_OFFSET_MAX = 256;
const WINDOW_CONTROLS_LEFT_OFFSET_DEFAULT = 0;

function isFiniteGeometryNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Normalize a plugin config snapshot (`{ "region-height", "left-offset" }`)
// to a frozen `{ x, y, width, height }` geometry. `region-height` H defaults
// to 30; finite values round to whole px, then clamp to 30..64 (24 is never
// valid). `left-offset` is a RELATIVE adjustment L defaulting to 0 — the view
// origin is x = m+L (vertical margin m=(H-24)/2 plus L, so the cluster keeps
// a balanced left inset as H grows: default H=30 -> x=3; H=40 -> x=8);
// finite values round, then clamp
// L to 0..256. The view is always 72 wide (3x24) and H tall at y = 0; three
// transparent 24x24 hit cells tile the width exactly (pitch 24, visual gap
// 10) and are vertically centered by the flex container, i.e. at margin
// m=(H-24)/2 (default H=30 -> m=3, cells y=3..27). The 14px light is centered
// in each cell (inset 5). Never throws; reads nothing but its argument.
// No DPR/scaleFactor reads: H in means exactly H out on every display.
function normalizeWindowControlsGeometry(input) {
  const src = input && typeof input === "object" ? input : {};
  const rawHeight = src["region-height"];
  const rawAdjust = src["left-offset"];
  const height = isFiniteGeometryNumber(rawHeight)
    ? Math.min(
        WINDOW_CONTROLS_REGION_HEIGHT_MAX,
        Math.max(WINDOW_CONTROLS_REGION_HEIGHT_MIN, Math.round(rawHeight)),
      )
    : WINDOW_CONTROLS_REGION_HEIGHT_DEFAULT;
  const adjust = isFiniteGeometryNumber(rawAdjust)
    ? Math.min(
        WINDOW_CONTROLS_LEFT_OFFSET_MAX,
        Math.max(0, Math.round(rawAdjust)),
      )
    : WINDOW_CONTROLS_LEFT_OFFSET_DEFAULT;
  // Left origin tracks the vertical margin so the cluster keeps a balanced
  // inset as H grows: x = (H-24)/2 + L (default H=30 -> x=3; H=40 -> x=8).
  return Object.freeze({
    x: (height - WINDOW_CONTROLS_CELL_SIZE) / 2 + adjust,
    y: 0,
    width: 3 * WINDOW_CONTROLS_CELL_SIZE,
    height,
  });
}

function sameWindowControlsGeometry(a, b) {
  return (
    !!a &&
    !!b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

// Accept either a plugin config snapshot or an already-normalized geometry
// (frozen `{ x, y, width, height }`): normalized geometries pass through
// untouched so view builders never re-normalize (which would drop the shape
// back to defaults — config keys and geometry fields never collide).
function asWindowControlsGeometry(value) {
  if (
    value &&
    typeof value === "object" &&
    isFiniteGeometryNumber(value.x) &&
    isFiniteGeometryNumber(value.y) &&
    isFiniteGeometryNumber(value.width) &&
    isFiniteGeometryNumber(value.height)
  ) {
    return value;
  }
  return normalizeWindowControlsGeometry(value);
}

// Default geometry bounds (missing config): 72x30 at (3, 0).
const WINDOW_CONTROLS_VIEW_BOUNDS = { x: 3, y: 0, width: 72, height: 30 };
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

// Overlay CSS for one geometry (embedded in the trusted view HTML, never in
// the page). macOS-style chromeless lights: the document is fully transparent
// (html/body, no pill background, no rounded container) and content-sized
// (inline-block body — the three 24px cells tile the 72px width exactly),
// with overflow clipped (never scrollbars). Each link is a transparent 24x24
// hit square (flex-centered in an H-tall flex row, so cells sit at vertical
// margin m=(H-24)/2 by construction, default m=3); the visual is one 14px
// inline SVG per link (circle + hover-only glyph path, inset 5, pitch 24,
// gap 10), both perfectly centered by construction (no font-dependent text
// centering). Hover glyphs mirror the DOM-move path (close ×, minimize –,
// maximize +): pure CSS, legal because functional lights are clickable
// (the decorative fallback keeps no hover).
function windowControlsViewCss(geometry) {
  const g = asWindowControlsGeometry(geometry);
  const h = g.height;
  return [
    "html,body{margin:0;padding:0;background:transparent;overflow:hidden;}",
    "body{display:inline-block;background:transparent;}",
    ".wc{display:flex;height:" +
      h +
      "px;align-items:center;-webkit-app-region:no-drag;user-select:none;}",
    ".wc a{display:flex;align-items:center;justify-content:center;width:" +
      WINDOW_CONTROLS_CELL_SIZE +
      "px;height:" +
      WINDOW_CONTROLS_CELL_SIZE +
      "px;text-decoration:none;color:rgb(0 0 0 / 55%);}",
    ".wc a svg{display:block;}",
    ".wc a .wc-glyph{display:none;}",
    ".wc a:hover .wc-glyph{display:block;}",
    ".wc a:focus-visible{outline:2px solid #0a84ff;outline-offset:-2px;}",
  ].join("");
}

// Default-geometry CSS (missing config).
const WINDOW_CONTROLS_VIEW_CSS = windowControlsViewCss(undefined);

function windowControlsViewBounds(geometry) {
  const g = asWindowControlsGeometry(geometry);
  return { x: g.x, y: g.y, width: g.width, height: g.height };
}

// Localized tooltip + group strings, keyed by language tag prefix.
// Extensible: to add a language, add one table entry — resolution below
// longest-prefix-matches the requested locale against the keys, falling
// back to "en". `controls` names the group itself (localized group
// aria-label); it has no tooltip-* override key by design.
const WINDOW_CONTROLS_LABELS = Object.freeze({
  en: Object.freeze({ close: "Close", minimize: "Minimize", maximize: "Maximize", restore: "Restore", controls: "Window controls" }),
  zh: Object.freeze({ close: "关闭", minimize: "最小化", maximize: "最大化", restore: "还原", controls: "窗口控件" }),
});

// Plugin config keys for per-action tooltip overrides. An absent, empty, or
// non-string value falls through to the language table; a non-empty string
// (trimmed, capped) wins for its action.
const WINDOW_CONTROLS_TOOLTIP_CONFIG_KEYS = Object.freeze({
  close: "tooltip-close",
  minimize: "tooltip-minimize",
  maximize: "tooltip-maximize",
  restore: "tooltip-restore",
});

const WINDOW_CONTROLS_LABEL_MAX_LENGTH = 128;

function resolveWindowControlsLanguage(locale) {
  const tag = typeof locale === "string" ? locale.toLowerCase() : "";
  const keys = Object.keys(WINDOW_CONTROLS_LABELS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (tag.length > 0 && tag.startsWith(key)) return key;
  }
  return "en";
}

function truncateWindowControlsLabel(value) {
  const chars = Array.from(String(value));
  return chars.length > WINDOW_CONTROLS_LABEL_MAX_LENGTH
    ? chars.slice(0, WINDOW_CONTROLS_LABEL_MAX_LENGTH).join("")
    : chars.join("");
}

function resolveWindowControlsLabels(language, overrides) {
  // Accept a raw locale or an already-resolved key: normalize first so both
  // spellings behave identically.
  const table =
    WINDOW_CONTROLS_LABELS[resolveWindowControlsLanguage(language)] ||
    WINDOW_CONTROLS_LABELS.en;
  const pick = (key) => {
    const overrideKey = WINDOW_CONTROLS_TOOLTIP_CONFIG_KEYS[key];
    const raw =
      overrides && typeof overrides === "object" ? overrides[overrideKey] : undefined;
    if (typeof raw === "string") {
      const text = truncateWindowControlsLabel(raw.trim());
      if (text.length > 0) return text;
    }
    return table[key];
  };
  return {
    close: pick("close"),
    minimize: pick("minimize"),
    maximize: pick("maximize"),
    restore: pick("restore"),
    // Group label: table-only, no config override key exists for it.
    controls: table.controls,
  };
}

// Attribute-escape for overlay HTML text (user-overridable tooltip strings).
// Token/actions are fixed tokens and need no escaping.
function escapeWindowControlsAttrText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Symmetric hover-glyph paths on a 14x14 grid (center 7,7), shared with
// the DOM-move path's data-URI shapes (source: OpenChamber `size-3.5`
// = 14 CSS px).
const WINDOW_CONTROLS_GLYPH_PATHS = Object.freeze({
  close: "M4.75 4.75L9.25 9.25M9.25 4.75L4.75 9.25",
  minimize: "M4.5 7H9.5",
  toggleMaximize: "M7 4.5V9.5M4.5 7H9.5",
});

function windowControlsGlyphSvg(action) {
  return (
    '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="6.5" fill="' +
    (action === "close"
      ? "#ff5f57"
      : action === "minimize"
        ? "#febc2e"
        : "#28c840") +
    '" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>' +
    '<path class="wc-glyph" d="' +
    WINDOW_CONTROLS_GLYPH_PATHS[action] +
    '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    "</svg>"
  );
}

// Fixed overlay HTML for the trusted view. `token` is the host-generated
// per-window unguessable token (never placed in the main page). No <script>:
// buttons are plain links with `target="_blank"`; clicks become window-open
// requests the host verifies then denies (plus a navigation event on builds
// that navigate instead). `labels` selects the tooltip strings plus the
// group label (`{ close, minimize, maximize, restore, controls }`, defaults
// to English); user text is attribute-escaped. `encodeHtml` is internal (token is hex, actions are
// fixed).
function windowControlsViewHtml(token, geometry, labels) {
  const t = String(token || "");
  const lang =
    labels && typeof labels === "object" ? labels : WINDOW_CONTROLS_LABELS.en;
  const text = (key) =>
    escapeWindowControlsAttrText(
      typeof lang[key] === "string" && lang[key].length > 0
        ? lang[key]
        : WINDOW_CONTROLS_LABELS.en[key],
    );
  const link = (action, labelKey) =>
    '<a target="_blank" href="' +
    WINDOW_CONTROLS_SCHEME +
    "://" +
    t +
    "/" +
    action +
    '" data-action="' +
    action +
    '" aria-label="' +
    text(labelKey) +
    '" title="' +
    text(labelKey) +
    '">' +
    windowControlsGlyphSvg(action) +
    "</a>";
  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
    windowControlsViewCss(geometry) +
    "</style></head><body><div class=\"wc\" role=\"group\" aria-label=\"" +
    text("controls") +
    "\">" +
    link("close", "close") +
    link("minimize", "minimize") +
    link("toggleMaximize", "maximize") +
    "</div></body></html>"
  );
}

function windowControlsViewDataUrl(token, geometry, labels) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(windowControlsViewHtml(token, geometry, labels))
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
// not attacker page content. `labels` selects the maximize/restore flip
// strings (`{ maximize, restore }`, English defaults); values ride inside a
// JSON string literal, never HTML.
function windowControlsSyncSnippet(isMaximized, labels) {
  const lang = labels && typeof labels === "object" ? labels : {};
  const maximizeText =
    typeof lang.maximize === "string" && lang.maximize.length > 0
      ? lang.maximize
      : WINDOW_CONTROLS_LABELS.en.maximize;
  const restoreText =
    typeof lang.restore === "string" && lang.restore.length > 0
      ? lang.restore
      : WINDOW_CONTROLS_LABELS.en.restore;
  const label = isMaximized ? restoreText : maximizeText;
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
  WINDOW_CONTROLS_LIGHT_DIAMETER,
  WINDOW_CONTROLS_CELL_SIZE,
  WINDOW_CONTROLS_LIGHT_PITCH,
  WINDOW_CONTROLS_LIGHT_GAP,
  WINDOW_CONTROLS_LIGHT_INSET,
  WINDOW_CONTROLS_REGION_HEIGHT_MIN,
  WINDOW_CONTROLS_REGION_HEIGHT_MAX,
  WINDOW_CONTROLS_REGION_HEIGHT_DEFAULT,
  WINDOW_CONTROLS_LEFT_OFFSET_MAX,
  WINDOW_CONTROLS_LEFT_OFFSET_DEFAULT,
  normalizeWindowControlsGeometry,
  sameWindowControlsGeometry,
  asWindowControlsGeometry,
  WINDOW_CONTROLS_LABELS,
  WINDOW_CONTROLS_TOOLTIP_CONFIG_KEYS,
  WINDOW_CONTROLS_LABEL_MAX_LENGTH,
  WINDOW_CONTROLS_GLYPH_PATHS,
  resolveWindowControlsLanguage,
  resolveWindowControlsLabels,
  truncateWindowControlsLabel,
  escapeWindowControlsAttrText,
  windowControlsGlyphSvg,
  windowControlsViewBounds,
  WINDOW_CONTROLS_VIEW_BOUNDS,
  WINDOW_CONTROLS_SAFE_PREFERENCES,
  windowControlsViewCss,
  WINDOW_CONTROLS_VIEW_CSS,
  windowControlsViewHtml,
  windowControlsViewDataUrl,
  generateWindowControlsToken,
  parseWindowControlsNavigation,
  windowControlsSyncSnippet,
  isWindowControlsAction,
  applyWindowControlsAction,
};

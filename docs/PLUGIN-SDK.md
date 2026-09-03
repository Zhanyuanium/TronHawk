# TronHawk Plugin SDK

Public API for plugin developers. Plugins must NOT depend on Electron private APIs, Chromium
internals, or target-app implementation details.

## Implemented vs. future API surface

The types below are the stable public contract, but **not every API is wired into the host
runtime yet**. A plugin that calls a future API will not get a working call today; do not build
a plugin on an API that is marked *future*. The authoritative runtime behavior lives in
`crates/runtime` (`crates/runtime/js/src/index.js`); remaining work is tracked in
`docs/BACKLOG.md`.

| Where | API | Status |
|---|---|---|
| both | `ctx.logger` (info/warn/error) | Implemented — host-attributed, string-only |
| renderer | `renderer.css`: data-only CSS pipeline (CSS-only plugins via a manifest `css`/`entry.css` file) | Implemented — stylesheets are injected into each window via `webContents.insertCSS` and removed on unload/revocation; CSS-only plugins never execute JS |
| renderer | `ctx.css.insert` / `ctx.css.remove` | Future — the `CssAPI` host functions are typed in the SDK but not yet exposed to the renderer QuickJS context; CSS-injection today is data-only from the manifest, not a runtime-callable host function |
| renderer | `ctx.script.setDocumentTitle` (`renderer.script`) | Implemented — host-owned fixed assignment; input is data, never JS source |
| main | `ctx.window.onCreated` / `setOpacity` / `setSize` / `setPosition` (`electron.window`) | Implemented |
| renderer | `ctx.dom.query` / `ctx.dom.observe` (`renderer.dom`) | Future — needs async host functions (the sync QuickJS variant cannot drain pending jobs) |
| main | `ctx.window.setVibrancy` / `setMica` | Future — true glass not wired; only opacity/size/position exist today |
| main | `ctx.webContents.*` | Future |
| both | `ctx.session.*` | Future |
| both | `ctx.ipc.*` | Future |
| both | `ctx.network.request` (`network.access`) | Future — typed, but Core permission + domain-whitelist enforcement is not wired yet |
| both | `ctx.config.get` / `ctx.config.set` | Future — config persistence is not wired to a settings store yet |
| both | `ctx.raw` (`runtime.unsafe`, developer mode) | Implemented — raw host execution while developer mode is on + `runtime.unsafe` granted |

**Lifecycle contract (binding):** `activate`, `deactivate`, and window callbacks must complete
**synchronously** and return JavaScript `undefined`. The runtime rejects any other result,
including a Promise/thenable. Async (Promise-returning) lifecycle is future — it requires
QuickJS pending-job draining and a `deactivate(ctx)` call that is not yet invoked.

## Plugin structure

```
my-plugin/
├── package.json
├── manifest.json
└── src/{renderer.ts, main.ts}
```

## Manifest

Required: `id`, `name`, `version`, `author`, `tronhawk` (host runtime protocol version, e.g. `"^0.1"`).
Optional: `css` (inline CSS string, or `entry.css` file) for CSS-only themes,
`entry.{renderer,main}` (renderer → Chromium renderer, main → Electron main process),
`permissions[]`, `config{}`. A CSS-only theme declares its CSS as **data** (never executed as JS).

The `tronhawk` field declares the TronHawk **runtime protocol version** the plugin targets — it is
NOT the SDK npm version.

```json
{
  "id": "com.example.dark-theme",
  "name": "Dark Theme",
  "version": "1.0.0",
  "author": "Example",
  "tronhawk": "^0.1",
  "entry": { "css": "theme.css" },
  "permissions": ["renderer.css"]
}
```

## Permissions reference

| Permission | API | Risk |
|---|---|---|
| `renderer.css` | `ctx.css.insert()` / `ctx.css.remove()` | low |
| `renderer.script` | `ctx.script.setDocumentTitle()` | medium |
| `renderer.dom` | `ctx.dom.query()` / `ctx.dom.observe()` | medium |
| `electron.window` | `ctx.window.setOpacity()` / `setVibrancy()` / `setMica()` | high |
| `electron.webContents` | DevTools, navigation, preload | — |
| `electron.session` | User-Agent, proxy, cookies (future) | — |
| `electron.ipc` | observe / intercept IPC (future) | high |
| `network.access` | `ctx.network.request()` (domain whitelist) | — |
| `network.proxy` | request interception / modification | high |
| `runtime.unsafe` | `ctx.raw` (Electron / Node) | critical (dev only) |

## Lifecycle

```ts
export default {
  activate(ctx) { /* load, register hooks */ },
  deactivate(ctx) { /* cleanup */ },
}
```

`activate` / `deactivate` must complete synchronously and return JavaScript `undefined` (a normal
function with no `return` statement does this). The runtime rejects any other result, including a
Promise/thenable, and does not activate that plugin. Async lifecycle hooks are not supported until
the QuickJS runtime implements pending-job draining.

## Renderer API (`RendererContext`)

```ts
interface RendererContext extends PluginContext { css; dom; script; }
```

- `ctx.css.insert(css)` / `ctx.css.remove(id)` — stylesheets carry owner plugin id + unique id
  (`tronhawk://glass-ui/style-1`) to avoid conflicts between plugins.
- `ctx.dom.query(selector)`; `ctx.dom.observe(selector, cb)` — MutationObserver abstraction, for
  React/Vue dynamic DOM.
- `ctx.script.setDocumentTitle(title)` — requires `renderer.script`; sets only `document.title`.
  The host serializes the title as data and does not execute plugin-provided JavaScript source.
- (future) `ctx.storage.get()/set()` — unified access to localStorage/IndexedDB (do NOT touch raw
  `localStorage`).

## Main API (`MainContext`)

```ts
interface MainContext extends PluginContext { window; webContents; }
```

- `ctx.window.onCreated(cb)` — `cb` receives an opaque `WindowHandle`; every window mutation takes
  that handle, so multi-window apps are unambiguous. The callback must complete synchronously and
  return `undefined`; otherwise the runtime unregisters it.
- `ctx.window.setOpacity(win, n)` / `setSize(win, w, h)` / `setPosition(win, x, y)` — cross-platform.
- `ctx.window.setVibrancy(win, material)` (macOS) / `setMica(win, enabled)` (Windows 11) — return a
  structured error on unsupported platforms.
- `ctx.webContents.openDevTools(win)` / `reload(win)`.
- (future) `ctx.session.modify()` (User-Agent, proxy, request interception).
- (future) `ctx.ipc.on()/send()/intercept()` — high privilege.

## Logging & network

- Log string messages via `ctx.logger.info()/warn()/error()`. The host supplies this logger in both
  main and renderer contexts and attributes every accepted event to the owning plugin; plugin code
  cannot override the plugin identity or add arbitrary event fields. Non-string values are ignored.
  Messages are bounded client-side and validated again by Core. `console.log()` is not captured and
  is not formal logging.
- Network only via `await ctx.network.request({ url, method })` (requires `network.access`); Core
  enforces permission + domain whitelist + logging/blocking. Interception requires `network.proxy`.

## Config

Declare a schema in `manifest.json`; the Manager auto-generates a settings UI:

```json
{ "config": { "opacity": { "type": "number", "default": 0.8 } } }
```

`ctx.config.get(key)` returns `unknown` until per-plugin schema typing lands; `ctx.config.set(key, value)`.

## Plugin-to-plugin communication

Forbidden in MVP (future: service API).

## Developer mode

Developer mode is a **deliberate, off-by-default exception** to the sandbox, for plugins you write
and trust on apps you control. A plugin whose `granted` includes `runtime.unsafe` — possible only
while developer mode is on (Manager Settings toggle) and the target app is support level 2 — bypasses
QuickJS entirely: its `main`/`renderer` source runs directly in the **host main process** via
`new Function`, and `ctx.raw` exposes the real host surfaces:

- `ctx.raw.electron` — the **real Electron module** of the injected app (`require("electron")`).
- `ctx.raw.node.require` / `ctx.raw.node.process` — the **real Node.js `require` and `process`** of
  the injected app's main process.

The sandbox limits do **NOT** apply to a raw plugin: no QuickJS VM, **no one-second CPU deadline**,
and **no memory or stack limits**. Execution is **synchronous in the host main process**, so a raw
plugin can block the target app indefinitely, hang it, or even call `process.exit()` on it. Side
effects (files written, processes spawned, network connections opened, app data read) **persist after
developer mode is turned off** — the runtime cannot undo what raw code already did.

Raw execution is only for plugins you write and trust. A sandboxed plugin never sees `ctx.raw`; it is
present only with the `runtime.unsafe` grant while developer mode is on.

## Build

Dev: `npm install` + `npm run dev`. Prod: `npm run build` → `plugin.thx`.

## Examples

Dark mode (renderer): `permissions:["renderer.css"]` → declare the CSS as data:
`"css": "body { background:#111; }"` (injected via `insertCSS`; no plugin JS is executed).

Glass window (main): `permissions:["electron.window"]` →
`ctx.window.onCreated(w => { ctx.window.setVibrancy(w, "sidebar"); })`.

## Stability & design rules

SemVer: major = breaking, minor = new capability, patch = fix. Every new API must have: a
permission model, tests, docs, error handling, and no exposure of internal implementation.

## Sandbox limits

Renderer and main plugin code runs in QuickJS without raw DOM, network, Node, or Electron access.
Every evaluation and host-invoked plugin callback has a one-second CPU deadline, in addition to the
runtime memory and stack limits. Renderer page access is restricted to documented host APIs; there
is no arbitrary JavaScript execution bridge.

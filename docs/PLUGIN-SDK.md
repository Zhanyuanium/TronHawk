# TronHawk Plugin SDK

Public API for plugin developers. Plugins must NOT depend on Electron private APIs, Chromium
internals, or target-app implementation details.

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
| `renderer.script` | `ctx.script.execute()` | medium |
| `renderer.dom` | `ctx.dom.query()` / `ctx.dom.observe()` | medium |
| `electron.window` | `ctx.window.setOpacity()` / `setVibrancy()` / `setMica()` | — |
| `electron.webContents` | DevTools, navigation, preload | — |
| `electron.session` | User-Agent, proxy, cookies (future) | — |
| `electron.ipc` | observe / intercept IPC (future) | high |
| `network.access` | `ctx.network.request()` (domain whitelist) | — |
| `network.proxy` | request interception / modification | high |
| `runtime.unsafe` | `ctx.raw` (Electron / Node) | dev only |

## Lifecycle

```ts
export default {
  activate(ctx) { /* load, register hooks */ },
  deactivate(ctx) { /* cleanup */ },
}
```

`activate` / `deactivate` may return `void | Promise<void>`; the runtime awaits returned promises.

## Renderer API (`RendererContext`)

```ts
interface RendererContext extends PluginContext { css; dom; script; }
```

- `ctx.css.insert(css)` / `ctx.css.remove(id)` — stylesheets carry owner plugin id + unique id
  (`tronhawk://glass-ui/style-1`) to avoid conflicts between plugins.
- `ctx.dom.query(selector)`; `ctx.dom.observe(selector, cb)` — MutationObserver abstraction, for
  React/Vue dynamic DOM.
- `ctx.script.execute(code)` — requires `renderer.script`; runs in plugin context.
- (future) `ctx.storage.get()/set()` — unified access to localStorage/IndexedDB (do NOT touch raw
  `localStorage`).

## Main API (`MainContext`)

```ts
interface MainContext extends PluginContext { window; webContents; }
```

- `ctx.window.onCreated(cb)` — `cb` receives an opaque `WindowHandle`; every window mutation takes
  that handle, so multi-window apps are unambiguous.
- `ctx.window.setOpacity(win, n)` / `setSize(win, w, h)` / `setPosition(win, x, y)` — cross-platform.
- `ctx.window.setVibrancy(win, material)` (macOS) / `setMica(win, enabled)` (Windows 11) — return a
  structured error on unsupported platforms.
- `ctx.webContents.openDevTools(win)` / `reload(win)` / `executeJavaScript(win, code)`.
- (future) `ctx.session.modify()` (User-Agent, proxy, request interception).
- (future) `ctx.ipc.on()/send()/intercept()` — high privilege.

## Logging & network

- Log via `ctx.logger.info()/warn()/error()` — format `[Plugin ID][Level][Timestamp] message`.
  `console.log()` is not formal logging.
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

`ctx.raw.electron` / `ctx.raw.node` only with `runtime.unsafe` permission + developer mode enabled.

## Build

Dev: `npm install` + `npm run dev`. Prod: `npm run build` → `plugin.thx`.

## Examples

Dark mode (renderer): `permissions:["renderer.css"]` → declare the CSS as data:
`"css": "body { background:#111; }"` (injected via `insertCSS`; no plugin JS is executed).

Glass window (main): `permissions:["electron.window"]` →
`ctx.window.onCreated(w => ctx.window.setVibrancy(w, "sidebar"))`.

## Stability & design rules

SemVer: major = breaking, minor = new capability, patch = fix. Every new API must have: a
permission model, tests, docs, error handling, and no exposure of internal implementation.

## Open questions

1. Renderer sandbox: isolated world vs page world (needs electron-hook validation).
2. Main-runtime JS loading: Node VM vs QuickJS sandbox vs V8 context isolation.
3. Plugin dependency isolation: bundle vs shared runtime vs npm-style cache.

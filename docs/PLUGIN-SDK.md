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

Required: `id`, `name`, `version`, `author`, `tronhawk` (e.g. `"^1.0"`).
Optional: `entry.{renderer,main}` (renderer → Chromium renderer, main → Electron main process),
`permissions[]`, `config{}`. Both entries optional (a CSS-only theme needs only `renderer`).

```json
{
  "id": "com.example.glass-ui",
  "name": "Glass UI",
  "version": "1.0.0",
  "author": "Example",
  "tronhawk": "^1.0",
  "entry": { "renderer": "dist/renderer.js", "main": "dist/main.js" },
  "permissions": ["renderer.css"]
}
```

## Permissions reference

| Permission | API | Risk |
|---|---|---|
| `renderer.css` | `ctx.css.insert()` / `ctx.css.remove()` | low |
| `renderer.script` | `ctx.script.execute()` | medium |
| `renderer.dom` | `ctx.dom.query()` / `ctx.dom.observe()` | medium |
| `electron.window` | `ctx.window.setOpacity()` / `setVibrancy()` | — |
| `electron.webContents` | DevTools, navigation, preload | — |
| `electron.session` | User-Agent, proxy, cookies | — |
| `electron.ipc` | observe / intercept IPC | high |
| `network` | `ctx.network.request()` (domain whitelist) | proxy = high |
| `runtime.unsafe` | `ctx.raw` (Electron / Node) | dev only |

## Lifecycle

```ts
export default {
  activate(ctx) { /* load, register hooks */ },
  deactivate(ctx) { /* cleanup */ },
}
```

## Renderer API (`RendererContext`)

```ts
interface RendererContext { css; dom; script; storage; events; }
```

- `ctx.css.insert(css)` / `ctx.css.remove(id)` — stylesheets carry owner plugin id + unique id
  (`tronhawk://glass-ui/style-1`) to avoid conflicts between plugins.
- `ctx.dom.query(selector)`; `ctx.dom.observe(selector, cb)` — MutationObserver abstraction, for
  React/Vue dynamic DOM.
- `ctx.script.execute(code)` — requires `renderer.script`; runs in plugin context.
- `ctx.storage.get()/set()` — future; unified access to localStorage/IndexedDB (do NOT touch raw `localStorage`).

## Main API (`MainContext`)

```ts
interface MainContext { window; webContents; session; ipc; }
```

- `ctx.window.onCreated(cb)`; MVP `setOpacity()` / `setSize()` / `setPosition()`,
  future `setVibrancy()` / `setMica()` / `setTrafficLightPosition()`.
- `ctx.webContents`: MVP `openDevTools()` / `reload()` / `executeJavaScript()`,
  future `injectPreload()` / `modifyNavigation()`.
- `ctx.session.modify()` — future (User-Agent, proxy, request interception).
- `ctx.ipc.on()/send()/intercept()` — future; high privilege.

## Logging & network

- Log via `ctx.logger.info()/warn()/error()` — format `[Plugin ID][Level][Timestamp] message`.
  `console.log()` is not formal logging.
- Network only via `await ctx.network.request({ url, method })`; Core enforces permission +
  domain whitelist + logging/blocking.

## Config

Declare a schema in `manifest.json`; the Manager auto-generates a settings UI:

```json
{ "config": { "opacity": { "type": "number", "default": 0.8 } } }
```

## Plugin-to-plugin communication

Forbidden in MVP (future: service API).

## Developer mode

`ctx.raw.electron` / `ctx.raw.node` only with `runtime.unsafe` permission + developer mode enabled.

## Build

Dev: `npm install` + `npm run dev`. Prod: `npm run build` → `plugin.thx`.

## Examples

Dark mode (renderer): `permissions:["renderer.css"]` →
`ctx.css.insert("body { background:#111; }")`.

Glass window (main): `permissions:["electron.window"]` →
`ctx.window.onCreated(w => ctx.window.setVibrancy(w, "sidebar"))`.

## Stability & design rules

SemVer: major = breaking, minor = new capability, patch = fix. Every new API must have: a
permission model, tests, docs, error handling, and no exposure of internal implementation.

## Open questions

1. Renderer sandbox: isolated world vs page world (needs electron-hook validation).
2. Main-runtime JS loading: Node VM vs QuickJS sandbox vs V8 context isolation.
3. Plugin dependency isolation: bundle vs shared runtime vs npm-style cache.

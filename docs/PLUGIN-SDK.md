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
| renderer | `ctx.css.insert` / `ctx.css.remove` (`renderer.css`) | Implemented — runtime-callable host functions on top of the manifest data-only CSS pipeline: `insert` injects via `webContents.insertCSS` and returns the key, `remove` revokes it (bounded retry); CSS-only plugins still never execute JS |
| renderer | `ctx.script.setDocumentTitle` (`renderer.script`) | Implemented — host-owned fixed assignment; input is data, never JS source |
| main | `ctx.window.onCreated` / `setOpacity` / `setSize` / `setPosition` (`electron.window`) | Implemented |
| main | `ctx.onLoad` / `ctx.onRendererReady` / `ctx.onUnload` (`electron.window`) | Implemented — main-context lifecycle events: `onLoad` fires once at app ready (a late subscription fires immediately), `onRendererReady` per window per load/navigation (a late subscription replays already-loaded windows), `onUnload` per window webContents destroy; synchronous `undefined` callbacks invoked under the CPU-deadline contract, fail-closed unregister on throw/timeout/non-void |
| both | async `activate` / `deactivate` (module lifecycle) | Implemented — a hook may return `undefined` synchronously or a Promise the runtime **drains** before the plugin is considered activated/deactivated (ADR 0008); lifecycle-event callbacks stay synchronous `undefined` |
| renderer | `ctx.dom.query` / `ctx.dom.observe` (`renderer.dom`) | Implemented — async host functions (ADR 0008): `query` returns a Promise of a serialized `DomElement` snapshot (never a live node), `observe` polls on a 500 ms cadence and delivers snapshots to a synchronous callback |
| renderer | `ctx.storage.get` / `ctx.storage.set` (`renderer.storage`) | Implemented — renderer-only, host-namespaced string storage (`tronhawk:<pluginId>:<key>`), values host-bounded (ADR 0008) |
| main | `ctx.window.setVibrancy` / `setMica` (`electron.window`) | Implemented — macOS vibrancy via `setVibrancy`, Windows 11 Mica via `setBackgroundMaterial`; structured-log no-op on other platforms or when the Electron API is absent |
| main | `ctx.webContents.*` | Future |
| both | `ctx.session.*` | Future |
| both | `ctx.ipc.*` | Future |
| both | `ctx.network.request` (`network.access`) | Implemented — Core-side domain-whitelisted fetch (ADR 0008); the promise rejects with a catchable error on a non-whitelisted URL or network failure. `ctx.network` is always present: without the grant (including raw plugins) it is a stub whose `request` rejects with `network.access not granted` |
| both | `ctx.config.get` / `ctx.config.set` | Implemented — get reads the per-app-per-plugin config snapshot (schema defaults overlaid with stored values); set is a no-op for sandboxed plugins (config is persisted only through the Manager settings form) |
| both | `ctx.raw` (`runtime.unsafe`, developer mode) | Implemented — raw host execution while developer mode is on + `runtime.unsafe` granted |

**Lifecycle contract (binding):** `activate` / `deactivate` may return JavaScript `undefined`
(synchronously) **or a Promise** (whose resolve value is ignored) — when a hook returns a Promise the runtime
**drains** it (via QuickJS pending-job execution) before the plugin is considered activated /
deactivated (ADR 0008). Lifecycle-event and window callbacks (`ctx.onLoad` / `ctx.onRendererReady` /
`ctx.onUnload` / `ctx.window.onCreated`, and `ctx.dom.observe` callbacks) stay **synchronous** and
must return JavaScript `undefined` — the runtime never drains their return value and unregisters any
callback that throws, exceeds its CPU deadline, or returns a non-`undefined` value.

## Plugin structure

```
my-plugin/
├── package.json
├── manifest.json
└── src/{renderer.js, main.js}   # executable CommonJS entries (see "Runtime entry format")
```

## Manifest

Required: `id`, `name`, `version`, `author`, `tronhawk` (host runtime protocol version, e.g. `"^0.1"`).
Optional: `css` (inline CSS string, or `entry.css` file) for CSS-only themes,
`entry.{renderer,main}` (renderer → Chromium renderer, main → Electron main process),
`permissions[]`, `config{}`. A CSS-only theme declares its CSS as **data** (never executed as JS).

**Renderer execution gate (binding):** an `entry.renderer` requires the
`renderer.script` permission in `permissions[]` — this is a pack/install-time
**declaration gate** enforced by `tronhawk-package`
(`validate_manifest_schema` rejects `entry.renderer` without
`renderer.script`). `renderer.dom` / `renderer.storage` / `renderer.css` are
**additional capabilities only** and never substitute for the gate; neither
does `runtime.unsafe` at declaration time. At runtime Core `execution_plan`
unlocks the renderer payload when the effective grants include
`renderer.script` **or** `runtime.unsafe` (the developer-mode escape hatch);
otherwise the payload is dropped before it ever runs and the drop is recorded
as `core.renderer.script_required` (observable via `queryLogs`).

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
| `renderer.storage` | `ctx.storage.get()` / `set()` — renderer-only, host-namespaced per-plugin keyspace | low |
| `electron.window` | `ctx.window.setOpacity()` / `setVibrancy()` / `setMica()` | high |
| `electron.webContents` | DevTools, navigation, preload | — |
| `electron.session` | User-Agent, proxy, cookies (future) | — |
| `electron.ipc` | observe / intercept IPC (future) | high |
| `network.access` | `ctx.network.request()` (Core-side domain-whitelisted fetch) | — |
| `network.proxy` | request interception / modification | high |
| `runtime.unsafe` | `ctx.raw` (Electron / Node) | critical (dev only) |

`renderer.script` is the **execution gate** for renderer JS, not just the
`ctx.script.setDocumentTitle()` capability: without it in the effective grants
the renderer payload never runs (Core drops it and records
`core.renderer.script_required`). `renderer.dom` / `renderer.storage` /
`renderer.css` grant only their own host APIs on top of a gated renderer entry
and never unlock execution by themselves; `runtime.unsafe` unlocks the payload
at runtime in developer mode but does **not** waive the pack-time declaration
gate (`entry.renderer` must still declare `renderer.script`).

## Lifecycle

```js
module.exports = {
  activate(ctx) { /* load, register hooks */ },
  deactivate(ctx) { /* cleanup */ },
};
```

`activate` / `deactivate` may complete **synchronously** (a normal function with no `return`
statement returns `undefined`) **or return a Promise**; when a hook returns a Promise the runtime
**drains** it (ADR 0008) before the plugin is considered activated / deactivated — e.g.
`async activate(ctx) { await ctx.dom.query("..."); }` is valid. The resolve value of a fulfilled Promise is ignored — only a rejection fails the hook. Lifecycle-**event** callbacks and
`ctx.dom.observe` callbacks are **not** drained — they stay synchronous `undefined`-returning (see
"Main lifecycle events").

## Renderer API (`RendererContext`)

```ts
interface RendererContext extends PluginContext { css; dom; script; storage; }
```

- `ctx.css.insert(css)` / `ctx.css.remove(id)` — stylesheets carry owner plugin id + unique id
  (`tronhawk://glass-ui/style-1`) to avoid conflicts between plugins.
- `ctx.dom.query(selector)` returns `Promise<DomElement | null>`; `ctx.dom.observe(selector, cb)`
  returns a disconnect function — for React/Vue dynamic DOM. Requires `renderer.dom`.
- `DomElement` is a **serialized snapshot, not a live node**: a real DOM `Element` cannot cross the
  QuickJS sandbox boundary, so the host copies `nodeId`, `tag`, `id`, `className`, `attrs`, `text`,
  and — when present — `rect`, `value`, `checked`, `href`, `src` at snapshot time. Later page
  mutations do not update an already-returned snapshot; re-query to refresh. `query` resolves the
  first element matching `selector`, or `null`. `observe` is a **polling** bridge (500 ms cadence),
  so a delivered snapshot can lag live DOM by up to one poll interval; each newly observed node is
  delivered once to `cb` (as a snapshot), and `cb` must complete synchronously and return
  `undefined`. There is no synchronous `dom.query` — a snapshot is inherently async to capture.
- `ctx.script.setDocumentTitle(title)` — requires `renderer.script`; sets only `document.title`.
  The host serializes the title as data and does not execute plugin-provided JavaScript source.
- `ctx.storage.get(key)` / `ctx.storage.set(key, value)` — requires `renderer.storage`; renderer-only
  host-namespaced string storage. See [Storage](#storage).

## Main API (`MainContext`)

```ts
interface MainContext extends PluginContext { window; onLoad; onRendererReady; onUnload; }
```

- `ctx.window.onCreated(cb)` — `cb` receives an opaque `WindowHandle`; every window mutation takes
  that handle, so multi-window apps are unambiguous. The callback must complete synchronously and
  return `undefined`; otherwise the runtime unregisters it.
- `ctx.window.setOpacity(win, n)` / `setSize(win, w, h)` / `setPosition(win, x, y)` — cross-platform.
- `ctx.window.setVibrancy(win, material)` (macOS) / `setMica(win, enabled)` (Windows 11) — macOS
  vibrancy (`BrowserWindow#setVibrancy`) and Windows 11 Mica (`BrowserWindow#setBackgroundMaterial`);
  on other platforms, or when the Electron API is absent, each is a no-op that emits a structured
  log instead of throwing.
- (future) `ctx.webContents.*` — not mounted in the host runtime; do not build on it.
- (future) `ctx.session.modify()` (User-Agent, proxy, request interception).
- (future) `ctx.ipc.on()/send()/intercept()` — high privilege.

### Main lifecycle events

`ctx.onLoad(cb)` / `ctx.onRendererReady(cb)` / `ctx.onUnload(cb)` attach at the main context **root**
— next to the module-level `activate`/`deactivate` lifecycle, not under `ctx.window` (which is the
window *mutation* surface). They announce the plugin host lifecycle and are available only in the
main context; the renderer context does not expose them. They are reachable whenever a sandboxed
main plugin runs (the `electron.window` grant).

Each registers a **synchronous, `undefined`-returning callback** (a normal function with no
`return` statement does this). Every invocation runs under the runtime's per-operation **CPU
deadline** contract, and the callback must return JavaScript `undefined` — a Promise/thenable is
rejected. A callback that **throws, exceeds its CPU deadline, or returns a non-`undefined` value
fails closed**: the runtime logs the failure and **unregisters that one subscription**, so it is
never re-invoked on later host events (the plugin itself stays loaded). Subscriptions are revoked
when the plugin is deactivated or its plan revision is removed.

Emit semantics:

- `ctx.onLoad(cb)` — fires **exactly once per subscription**, when the target app's main process has
  finished loading its original app (app ready). No window argument: it is the app-process boot
  event. A subscription made after the app already loaded fires immediately, exactly once.
- `ctx.onRendererReady(cb)` — fires **per window per renderer load** (`did-finish-load`, i.e. per
  navigation), carrying the window's `WindowHandle`. A subscription made after a window already
  loaded is replayed once for each such window, mirroring `onCreated`'s existing-window replay.
- `ctx.onUnload(cb)` — fires **per window when its `webContents` is destroyed**, carrying the
  destroyed window's `WindowHandle`. A quitting app always destroys its windows, so app shutdown is
  covered by the same path.

## Logging & network

- Log string messages via `ctx.logger.info()/warn()/error()`. The host supplies this logger in both
  main and renderer contexts and attributes every accepted event to the owning plugin; plugin code
  cannot override the plugin identity or add arbitrary event fields. Non-string values are ignored.
  Messages are bounded client-side and validated again by Core. `console.log()` is not captured and
  is not formal logging.
- Network only via `await ctx.network.request({ url, method })` (requires `network.access`);
  implemented (ADR 0008): Core enforces permission + a **domain whitelist** and the fetch runs
  Core-side, so the plugin never opens a raw socket. The returned promise **rejects with a catchable
  error** when the URL is outside the whitelist or the fetch fails — always `try/catch` around
  `await ctx.network.request(...)`. Interception requires `network.proxy`.

## Storage

`ctx.storage` is renderer-only host storage (requires `renderer.storage`). Keys and values are
strings. Every entry is stored host-side under the owning plugin's keyspace and namespaced by the
host as `tronhawk:<pluginId>:<key>` — a plugin can only read and write its **own** entries, never
another plugin's, and never the page's raw `localStorage`/IndexedDB (do not touch those from a
sandboxed plugin). Values are host-bounded. `get(key)` resolves the stored value, or `null` when
absent; `set(key, value)` persists it. This is per-install plugin state, not a page-data bridge.

## Config

Declare a schema in `manifest.json`; the Manager auto-generates a settings form from it:

```json
{ "config": { "opacity": { "type": "number", "default": 0.8, "label": "Opacity" } } }
```

Each field is `{ "type": "string" | "number" | "boolean", "default"?, "label"? }`; the schema is
limited to 32 keys, and `object`/`array` field types are reserved for a future release. The schema
is validated when the plugin is packed/installed.

Config is stored per-application × per-plugin in Core and carried into the per-plugin plan grant as
a merged snapshot (schema defaults overlaid with stored values). `ctx.config.get(key)` reads
synchronously from that snapshot in the QuickJS main and renderer contexts. `ctx.config.set(key, value)`
is a no-op for sandboxed plugins — plugins read config but never persist it; config is persisted only
through the Manager settings form. Editing config in the Manager changes the plan revision, so the
runtime reloads the plugin with the new values. Developer-mode (`runtime.unsafe`) plugins receive a
plain-object `config` instead of the `ctx.config` facade.

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

## Build and pack

Standalone toolchain (works outside any TronHawk checkout). The
`@tronhawk/cli` devDependency (the `tronhawk` binary) drives
`create` → `build` → `test --sandbox` → `pack` → `inspect`. Authoritative
checks always run in the same-version Rust engine (`tronhawk-pack`); a
passing `build` / `test` never substitutes for `validate`:

```sh
create-tronhawk-plugin my-plugin --type renderer
cd my-plugin && bun install
bun run build            # tronhawk build .: bundle entries to dist/ (CSS-only: no build step, style.css ships as data)
bun test                 # starter smoke test against @tronhawk/sdk mocks (no host)
tronhawk test . --sandbox  # QuickJS contract harness (ships inside the CLI, no checkout needed)
tronhawk validate .      # authoritative dir check (writes nothing)
tronhawk pack . my-plugin.thx   # build -> staging -> Rust pack (CSS-only: staging with no build -> Rust pack)
tronhawk inspect my-plugin.thx  # passthrough to the Rust engine (behavior defined by Rust)
```

- Type-check only: `bun install` + `bun run typecheck` (`tsc --noEmit`).
  This checks types; it does not bundle or pack anything.
- `tronhawk pack` is the unified pack command for every type: JS entries go
  `build` (isolated) → `smoke` (isolated) → minimal staging, then a single
  Rust `pack` (temp + same-crate round-trip + atomic rename inside Rust).
  CSS-only plugins skip `build` with an explicit notice but still run staging
  and the same-version Rust/SHA path. Never invoke the engine binary
  directly: only `tronhawk pack` enforces the expected-engine version,
  digest, and snapshot guarantees.
- Engine setup: set `TRONHAWK_PACK_BIN` to the same-version `tronhawk-pack`
  release binary (explicit, highest priority), configure `tronhawk.packBin`,
  or build it inside a TronHawk checkout (`cargo build -p tronhawk-package
  --release`, resolved from `target/{release,debug}/tronhawk-pack`). The
  CLI's `tronhawk.engineVersion` must exactly match `tronhawk-pack
  --version`; a missing binary, digest mismatch, or version mismatch
  hard-fails with install guidance — there is no TypeScript fallback packer
  and no PATH search for the engine.

Alternative (contributors inside a TronHawk monorepo checkout, from the repo
root only — the working directory must be the monorepo root because
`cargo run -p` resolves the `tronhawk-package` target through the Cargo
workspace context):

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> <out.thx>
```

The packer validates `manifest.json` and its entry files, then packs every
file in the plugin directory. It **refuses symlinks**, so remove
`node_modules` before packing and re-install afterwards if you keep
developing (the CLI staging does this selection automatically). See
`docs/THX-FORMAT.md` for the `.thx` layout, manifest schema,
and file-safety rules.

## Runtime entry format (binding)

The QuickJS host loads plugin entries as **CommonJS**: the source is evaluated
with `module` / `exports` scaffolding and the runtime reads
`module.exports.activate` / `module.exports.deactivate`.

```js
module.exports = {
  activate(ctx) { /* ... */ },
  deactivate(ctx) { /* ... */ },
};
```

TypeScript ESM (`import` / `export default`) is **never executed directly** —
an entry file containing `export default plugin` without a `module.exports`
assignment exports nothing the runtime recognizes, so `activate` never runs.
Point `entry.renderer` / `entry.main` at an executable `.js` file (the
scaffolder generates `src/renderer.js` / `src/main.js`); TypeScript sources may
be kept alongside as a type-checking source, but they are not the runtime
entry. CSS entries (`css` / `entry.css`) are **data** injected via
`insertCSS`, never executed.

## `tronhawk` manifest field

The manifest `tronhawk` field (e.g. `"^0.1"`) is the **host runtime protocol
version** the plugin targets, expressed as a semver range over the host
protocol (`HOST_PROTOCOL_VERSION`, currently `0.1.0`). It is **not** the
`@tronhawk/sdk` npm version. A plugin whose range does not match the running
host is rejected before install/load; the SDK version and the protocol version
evolve independently.

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

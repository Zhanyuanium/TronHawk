# TronHawk — Product & Architecture Spec

Consolidated single source of truth for product requirements and technical decisions.
(v0.1 — merges the former PRD, ARCHITECTURE, and injection research notes.)

## 1. What TronHawk Is

A **user-side extensibility platform for Electron apps**: inject plugins at runtime to customize
third-party Electron applications **without modifying their files on disk**.

Core principles (invariant):
1. **Runtime-only** — never modify the target exe, `app.asar`, bundled resources, Electron, or Chromium.
2. **User-controlled** — the user decides targets, enabled plugins, permissions, network, and advanced capabilities.
3. **Permission-controlled** — every privileged API checks a plugin's declared permissions.
4. **Community-extensible** — open plugin registry, independent development, compatibility profiles, third-party tooling.
5. **Layered** — strict separation between Manager, Core, Injector, Runtime, and Plugins.

## 2. Why (Problem)

Unlike browsers and IDEs, most desktop apps offer no extensibility. Users want to customize UI,
fix bad design, add missing features, improve accessibility, and integrate personal workflows —
TronHawk inserts a user-controlled extension layer between the user and the app.

## 3. Goals / Non-Goals

| | |
|---|---|
| **G1** | Stable runtime extension framework (renderer + Electron API + lifecycle events) |
| **G2** | Developer-friendly plugin ecosystem (JS/TS, npm) |
| **G3** | GUI manager: view apps, install/enable/disable plugins, review permissions, inspect logs |
| **G4** | Safe extension model: plugins declare permissions; users see access + risk |

Non-goals: binary modification (DLL patch / reverse engineering), Chromium replacement, universal
app modification (CEF best-effort only), and deliberately bypassing DRM / anti-cheat / banking /
enterprise security.

## 4. Users

- **Primary:** advanced desktop users (developers, power users, tinkerers) and plugin developers.
- **Non-target (MVP):** non-technical users, enterprise / managed environments.

## 5. Supported Apps & Levels

Target: Electron apps (ChatGPT Desktop, VS Code, Obsidian, Discord, Steam, …).
Support is tiered, not binary:

| Level | Capability |
|---|---|
| 0 | Unsupported |
| 1 | Renderer extension: CSS injection, JS injection, DOM manipulation |
| 2 | Electron extension: BrowserWindow (wired) / webContents / session / IPC (future, see PLUGIN-SDK) |

## 6. Tech Decisions

| Decision | Choice |
|---|---|
| Core / backend | Rust |
| Manager GUI | Tauri |
| Plugin language | TypeScript / JavaScript |
| Package format | `.thx` (ZIP) |
| Injection | electron-hook |
| Windows activation | IFEO (transparent launch) |
| Fallback activation | Launcher ("launch with extensions") |
| IPC | local socket, JSON-RPC |
| Permission model | Chrome-like (declared capabilities) |
| Plugin registry | metadata-only (npm-like) |
| Network | TronHawk proxy (permission-gated) |
| Hot reload | CSS (required) + optional JS |
| Native hook / file modification | No |

## 7. Architecture Layers

```
Manager (Tauri) → Core (Rust) → Injector (electron-hook) → Target Electron app
                                                            ├─ Renderer runtime (Chromium/V8)
                                                            └─ Main runtime (Node/Electron)
```

Layer responsibilities ("Must NOT" is binding):

| Layer | Location | Responsible for | Must NOT |
|---|---|---|---|
| Manager | `apps/manager` | UI, plugin mgmt, permission display, config | inject, execute plugins, touch target processes |
| Core | `crates/core` | lifecycle, plugin parse, permission check, IPC, storage | contain UI, depend on Electron internals |
| Injector | `crates/injector` | enter process, load bootstrap, establish comms | plugin logic, permission decisions |
| Runtime | `crates/runtime` | execute plugins, provide APIs, bridge to Electron | user / install management |

Repository layout:

```
apps/{manager, test-app}
crates/{core, injector, runtime, ipc, package}
sdk/            # TypeScript SDK (@tronhawk/sdk)
plugins/        # examples
docs/
tests/
```

## 8. Injection (Windows MVP)

Activation path: launch `Target.exe` → **IFEO** → TronHawk Injector → **electron-hook** → `bootstrap.js`.
Fallback: user launches via Manager ("Launch with extensions") — implemented: the Manager spawns
the co-located injector launcher (it does not inject into or touch the target itself), and the
launcher acquires the launch session.

Approach: **Windows + IFEO + electron-hook + launcher fallback.** Do NOT do binary patch,
Chromium replacement, or V8 hook.

Pre-production validation (must PoC → ADR before committing):
1. electron-hook renderer capability — ✅ validated (main-world JS + CSS)
2. electron-hook main-process capability — ✅ validated (full `require("electron")`)
3. latest Electron version compatibility — ✅ validated on Electron 43.4.1
4. ChatGPT Desktop — ⚠️ installed build is the MSIX `OpenAI.Codex` (owl Electron fork): injection
   + app load work, but full GUI startup fails under raw-exe launch (needs AUMID; see ADR).
5. VS Code — ❌ no `resources/app.asar` (unpacked `resources/app/`); the ASAR-remap path cannot
   target it. Obsidian (standard Electron 43.3.0) validated instead — injection + renderer
   CSS/DOM injection work; it loads via a custom `app://` protocol, which the per-app
   **compat adapter** covers (ADR 0001/0003).
   Root cause confirmed (ADR 0004): the minimal modded asar broke Obsidian's runtime module
   resolution (`@electron/remote`); fixed by a merged asar (Path I). A Sep-2026 real run confirmed
   the full note workspace rendering with `injected; electron=43.3.0`, `adapter active: obsidian`,
   and `CSS injected` events.

PoC → ADR: `docs/adr/0001-injection-backend.md`. electron-hook is **vendored** (`vendor/electron-hook/`,
LGPL-3.0 + MIT Detours) and activates via a **launcher wrapper** (Detours), so IFEO's `Debugger` key
routes launches through our injector launcher to preserve transparent-launch UX.

Main challenges: entering the main process (BrowserWindow / ipcMain / session), and modern-Electron
guards (contextIsolation, sandbox, ASAR, code cache, custom preload).

## 9. Plugin Model

Package `.thx` (ZIP): `manifest.json`, `dist/{renderer.js, main.js}`, `assets/` (`signature.json` / `metadata.json` are reserved for a future signed-package release and are not verified today).
Manifest required fields: `id`, `name`, `version`, `author`, `tronhawk`; optional `css` (inline CSS
data, or `entry.css` file) for CSS-only themes, `entry.{renderer,main}`, and `permissions[]`.

Execution contexts:
- **Renderer** (Chromium/V8): manifest CSS is data-only (CSS-only plugins never execute JS); plugins holding `renderer.css` can also call `ctx.css.insert` / `ctx.css.remove` at runtime; plugin JS runs in QuickJS with one-second evaluation
  and callback CPU deadlines. `renderer.script` only allows the host-owned document-title setter
  (ADR 0002); `renderer.dom` query/observe is implemented as async host functions returning
  serialized `DomElement` snapshots (ADR 0008); renderer-only `ctx.storage` is host-namespaced per
  plugin (`tronhawk:<pluginId>:<key>`); `electron.windowControls` mounts a host-hosted declarative
  traffic-light overlay (fixed style, current-window minimize / toggle-maximize / close, no plugin
  handle); raw localStorage / IndexedDB (future).
- **Main** (Node/Electron): BrowserWindow, session, webContents, IPC — via TronHawk APIs, not raw
  Electron; window APIs (`setOpacity`/`setSize`/`setPosition`) run via the QuickJS sandbox.
- **Async host functions** (ADR 0008): `ctx.network.request` (main + renderer), `ctx.dom.query`
  (renderer), `ctx.storage` (renderer), and `ctx.windowControls.mount` / `unmount`
  (renderer, `electron.windowControls`) are real Promise APIs backed by an **in-process
  host-driven pending-job pump** over the synchronous QuickJS VM (`vm.newPromise()` +
  `executePendingJobs()`). `activate`/`deactivate` may return a Promise the runtime drains.
  Lifecycle-**event** callbacks (`onCreated`/`onLoad`/`onRendererReady`/`onUnload`) and
  `ctx.dom.observe` callbacks stay **synchronous `undefined`** — the runtime never drains them.
- **`ctx.config`** (main + renderer): per-application × per-plugin config carried into the plan
  snapshot; `get(key)` reads synchronously from that snapshot, `set(key, value)` is a no-op for
  sandboxed plugins — config is persisted only via the Manager settings form.
- **Restricted declarative capability config** (`electron.windowControls`): the host reads
  exactly `region-height` (H, default 30, clamped 30..64) and `left-offset` (L, default 0,
  clamped 0..256) from the plan snapshot to size the overlay view (72xH at (m+L, 0)
  where m=(H-24)/2, default (3,0,72,30); constant 14px vector lights in 24x24 hit
  cells at pitch 24, gap 10, inset 5, vertical margin m=(H-24)/2). All values are CSS px (DIP), measured
  the same way on every display — no conversions, no `devicePixelRatio`/`scaleFactor`
  reads, no screen/window/viewport measurement, no automatic display adaptation
  (physical pixels are never taken as CSS px: 14 CSS = 28 physical at DPR=2).
  A plan revision with different values destroys the old view and rebuilds; co-owners
  with conflicting geometries fail closed on `mount()`. Tooltip strings come from a
  host-side en/zh table selected by `app.getLocale()` (`zh` prefix → Chinese, else
  English), including the localized group label (`Window controls` / `窗口控件`);
  optional `tooltip-*` string configs override individual entries when
  non-empty (trimmed, capped, escaped).
- **Developer mode** (`runtime.unsafe`): raw Electron/Node — opt-in via the Manager Settings view
  and off by default; a granted plugin executes with the real Node/Electron environment of the
  injected app (arbitrary code execution, outside the QuickJS sandbox).

Lifecycle: install → enable → load → app start → runtime hooks → unload → disable.
`activate`/`deactivate` may complete synchronously or return a Promise that the runtime drains before
the plugin is considered activated/deactivated (ADR 0008).
Events (MVP): `onLoad`, `onUnload`, `onRendererReady`, `onWindowCreated`;
(future) `onSessionCreated`, `onIPCMessage`, `onNetworkRequest`. Event callbacks stay synchronous
`undefined`-returning; the runtime never drains a callback return value.

Window-close teardown (R1 exit semantics, R2 plugin cap — binding):
- The native window is released synchronously on close; per-window teardown (guest
  `deactivate`, VM disposal, `onUnload` delivery) runs in a background pump preserving
  `deactivate`-before-`onUnload` order. `onUnload` fires exactly once per window for
  subscribers registered at destroy time.
- R1: if the process exits while background teardown is still queued (single-window quit,
  `app.exit`, kill, crash), not-yet-run guest `deactivate`/`onUnload` deliveries may be lost.
  VM disposal is still guaranteed by a dispose-only `will-quit` sweep (no guest code runs
  there) or, for a terminating process, by the OS. `app.exit`/kill/crash carry no delivery
  guarantee at all.
- R2: at most 8 renderer plugins per window (permanent invariant). Further loads fail closed
  with an error log; the first eight in stable plan order win deterministically.
- Accepted limits (Gate 2 scope-change): consecutive window transfers inside one event loop
  may head-of-line-block later windows for on the order of 2s (one guest deactivate call runs
  per pump turn under the CPU deadline before yielding); no upper bound is declared for a
  slow `disposeVM` itself; DUR-1 plan polling is guaranteed only to self-recover after cleanup
  drains, with no time-limit guarantee while teardown is concurrent.

API principles: capability-based (`ctx.window.setVibrancy()`, never `electron.BrowserWindow()`);
explicit per-context types (`RendererContext` / `MainContext` / `NetworkContext`); stable abstraction
(no Electron private / Chromium internals / unstable app internals).

Dependencies: npm-style, bundled into `.thx` at publish.
Network: plugins cannot `fetch()` directly — must use `ctx.network.request()` → Core permission check
+ domain whitelist + logging/audit. Implemented (ADR 0008): the fetch runs **Core-side** against the
domain whitelist and the returned promise rejects with a catchable error outside it.
Plugin-to-plugin communication: forbidden in MVP (future: service API).

## 10. Permissions

Goal: installing a theme must never grant full desktop control. Plugins are untrusted; every
privileged API verifies permission first.

| Permission | Allows | Risk |
|---|---|---|
| `renderer.css` | inject CSS | low |
| `renderer.script` | set `document.title` through a host-owned setter | medium |
| `renderer.dom` | read DOM via serialized `DomElement` snapshots (`query`/`observe`) | medium |
| `renderer.storage` | read/write this plugin's own host-namespaced storage (strings, bounded) | low |
| `electron.window` | modify window (`setOpacity`, `setVibrancy`) | high |
| `electron.windowControls` | host-hosted declarative traffic lights (`ctx.windowControls.mount` / `unmount`, fixed style, current-window minimize / toggle-maximize / close) | high |
| `electron.webContents` | page load, DevTools (future) | — |
| `electron.session` | UA, proxy, cookies (future) | — |
| `electron.ipc` | observe / intercept IPC (future) | high |
| `network.access` | internet access (Core-side domain-whitelisted fetch via `ctx.network.request`) | — |
| `network.proxy` | modify requests (future) | high |
| `runtime.unsafe` | raw Node / Electron (developer mode) | critical (opt-in, developer mode) |

Install UX: show requested vs not-requested capabilities (accept / reject / details).

## 11. Manager (Tauri)

MVP UI: Applications (with supported level), Plugins (enable / disable / remove), Permissions view,
plugin settings UI (schema-driven from the manifest `config{}`), launch-with-extensions button, Logs.
Copy is localized (en / zh) with the display language persisted per-user; a Core-autostart toggle
keeps the Core daemon registered to start at login so transparent launch works without opening the
Manager.

## 12. Data & Config

Storage root `%LOCALAPPDATA%\com.tronhawk.manager\core\` (overridable via `TRONHAWK_STORAGE_ROOT`) →
`config/`, `plugins/{installed, cache}`, `logs/`, `profiles/`, `runtime/`. On first start at this
default root, Core migrates the legacy `%LOCALAPPDATA%\TronHawk\` tree (merge-copy, best-effort
cleanup) so existing config, plugins, and logs survive.
Config tiers: global (`language`, `developerMode` — set by the Manager Settings view, off by
default; disabling developer mode purges every `runtime.unsafe` grant, `coreAutostart` — default on,
registers Core to start at login), application
(`enabledPlugins`), plugin — now wired: a manifest `config{}` schema (≤32 typed fields) is validated
at pack/install, per-application × per-plugin values are stored in Core policy, and edited via the
Manager's schema-driven settings form.
Logging: three durable streams — Core, Runtime, Plugin. Core owns a bounded JSONL ledger under
`logs/` with strict Core-generated sequence and attribution; Control may query, a launch session
may only append its own attributed Runtime/Plugin events, and the Manager displays it read-only.

## 13. SDK & DX

`@tronhawk/sdk` provides types (`PluginContext`, `RendererContext`, `MainContext`), utilities
(`injectCSS`, `createLogger`), and testing helpers (`createMockRendererContext`,
`createMockMainContext`).
Scaffolding CLI: `create-tronhawk-plugin`. Full API in `PLUGIN-SDK.md`.

## 14. Testing

- Unit: `cargo test` (Rust) / `bun test` (TS).
- Integration: `apps/test-app` — deterministic Electron env (BrowserWindow, renderer UI, IPC, session,
  dynamic DOM) used for plugin dev, CI, and AI-agent auto-verification.
- CI (GitHub Actions): commit → rust test → ts test → build → integration test → package. MVP: Windows x64.

## 15. Milestones

| M | Deliverable | Acceptance / demo |
|---|---|---|
| 0 Foundation | Rust workspace, Tauri shell, SDK, test app | skeleton builds |
| 1 Injection | electron-hook, IFEO, launcher fallback | launch test app → auto-inject → hello-world plugin runs |
| 2 Renderer plugins | `.thx`, manifest, CSS+JS injection, CSS hot reload | ✅ CSS + hot reload; JS injection landed in Phase 3 |
| 3 Main plugins | BrowserWindow API, window mod, permissions | ✅ window mod (setOpacity/setPosition/setSize) + glass (vibrancy/mica) |
| 4 Manager UI | install, enable/disable, logs, permissions | usable manager — install/register, enable/disable, redacted control plane, three-stream logs |
| 5 OSS prep | docs, examples, contribution guide | public-ready |

## 16. MVP Acceptance

- **User:** install TronHawk → install `.thx` → launch app → plugin auto-applies → view permissions → disable.
- **Developer:** create plugin → use SDK → debug → package `.thx` → verify in test app.

## 17. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| electron-hook compatibility | high | abstract the Injection Backend interface; never couple Core to electron-hook |
| Electron version fragmentation | — | future: application profiles |
| Plugin security | — | permission system |
| Main-runtime cleanup | — | no main-process hot-unload in MVP |

## 18. Deferred (not MVP)

Auto app recognition, application profiles, Explorer mode, plugin store UI, CEF support,
Linux/macOS injection, advanced native API.

> **Compat adapters** (ADR 0003) are the narrow, *trusted* slice of this concern — per-app
> compatibility shims bundled into `runtime.js` (e.g. Obsidian's custom `app://` protocol). They
> are distinct from the deferred **application profiles** (auto app recognition, per-app plugin
> selection UX, Manager UI), which remain out of MVP.

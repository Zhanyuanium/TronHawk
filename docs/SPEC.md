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
| 2 | Electron extension: BrowserWindow / webContents / session / IPC |

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
Fallback: user launches via Manager ("Launch with extensions").

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
   CSS/DOM injection work, but it loads via a custom `app://` protocol so only the shell renders
   (full UI needs application profiles; see ADR).

PoC → ADR: `docs/adr/0001-injection-backend.md`. electron-hook is **vendored** (`vendor/electron-hook/`,
LGPL-3.0 + MIT Detours) and activates via a **launcher wrapper** (Detours), so IFEO's `Debugger` key
routes launches through our injector launcher to preserve transparent-launch UX.

Main challenges: entering the main process (BrowserWindow / ipcMain / session), and modern-Electron
guards (contextIsolation, sandbox, ASAR, code cache, custom preload).

## 9. Plugin Model

Package `.thx` (ZIP): `manifest.json`, `dist/{renderer.js, main.js}`, `assets/`, `signature.json`, `metadata.json`.
Manifest required fields: `id`, `name`, `version`, `author`, `tronhawk`; optional `css` (inline CSS
data, or `entry.css` file) for CSS-only themes, `entry.{renderer,main}`, and `permissions[]`.

Execution contexts:
- **Renderer** (Chromium/V8): CSS (MVP, data-only); JS/DOM via a QuickJS sandbox (Phase 3, see
  ADR 0002); localStorage / IndexedDB (future).
- **Main** (Node/Electron): BrowserWindow, session, webContents, IPC — via TronHawk APIs, not raw Electron.
- **Developer mode** (`runtime.unsafe`): raw Electron/Node, off by default.

Lifecycle: install → enable → load → app start → runtime hooks → unload → disable.
Events (MVP): `onLoad`, `onUnload`, `onRendererReady`, `onWindowCreated`;
(future) `onSessionCreated`, `onIPCMessage`, `onNetworkRequest`.

API principles: capability-based (`ctx.window.setVibrancy()`, never `electron.BrowserWindow()`);
explicit per-context types (`RendererContext` / `MainContext` / `NetworkContext`); stable abstraction
(no Electron private / Chromium internals / unstable app internals).

Dependencies: npm-style, bundled into `.thx` at publish.
Network: plugins cannot `fetch()` directly — must use `ctx.network.request()` → Core permission check
+ domain whitelist + logging/audit.
Plugin-to-plugin communication: forbidden in MVP (future: service API).

## 10. Permissions

Goal: installing a theme must never grant full desktop control. Plugins are untrusted; every
privileged API verifies permission first.

| Permission | Allows | Risk |
|---|---|---|
| `renderer.css` | inject CSS | low |
| `renderer.script` | execute page JS | medium |
| `renderer.dom` | modify DOM | medium |
| `electron.window` | modify window (`setOpacity`, `setVibrancy`) | — |
| `electron.webContents` | page load, DevTools | — |
| `electron.session` | UA, proxy, cookies | — |
| `electron.ipc` | observe / intercept IPC | high |
| `network.access` | internet access (domain whitelist) | — |
| `network.proxy` | modify requests | high |
| `runtime.unsafe` | raw Node / Electron (developer mode) | off by default |

Install UX: show requested vs not-requested capabilities (accept / reject / details).

## 11. Manager (Tauri)

MVP UI: Applications (with supported level), Plugins (enable / disable / remove), Permissions view, Logs.

## 12. Data & Config

Storage root `%APPDATA%\TronHawk\` → `config/`, `plugins/{installed, cache}`, `logs/`, `profiles/`, `runtime/`.
Config tiers: global (`language`, `developerMode`), application (`enabledPlugins`), plugin (per-plugin settings).
Logging: three streams — Core, Runtime, Plugin (`[Plugin ID][Level][Timestamp] message`).

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
| 2 Renderer plugins | `.thx`, manifest, CSS+JS injection, CSS hot reload | ChatGPT dark theme |
| 3 Main plugins | BrowserWindow API, window mod, permissions | ChatGPT glass window |
| 4 Manager UI | install, enable/disable, logs, permissions | usable manager |
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

# TronHawk

A **runtime extension platform for Electron apps**. TronHawk lets you inject
plugins into third-party Electron applications at runtime — CSS themes,
renderer tweaks, and main-process window/Electron extensions — **without
modifying a single byte of the target app on disk**.

The target's executable, `app.asar`, bundled resources, Electron, and Chromium
are never altered (runtime-only, `docs/SPEC.md` §1). Extensions are
user-controlled, permission-gated, and sandboxed.

> Status: pre-release (`0.1`). Phases 0-4 are complete; Phase 5 (OSS prep) is
> in progress. MVP scope is **Windows x64**. See [Status](#status).

**[中文版](./README_zh.md)** — Chinese version of this document.

## Highlights

- **Non-invasive**: in-memory ASAR remap + DLL injection via electron-hook
  (Detours). No binary patching, no file rewrites, no Chromium replacement.
- **Sandboxed plugins**: plugin JS runs in an embedded QuickJS engine with **no
  DOM, network, Node, or Electron access by default**. Every evaluation and
  host-invoked callback has a **one-second CPU deadline** plus memory/stack
  limits; plugins that exceed the cumulative budget are hard-disabled.
- **Async host APIs**: `ctx.dom.query`/`observe` (serialized snapshots),
  `ctx.network.request` (Core-side domain-whitelisted fetch), `ctx.storage`,
  `ctx.config`, and runtime `ctx.css.insert`/`remove` are real Promises pumped
  through the synchronous QuickJS VM; `activate`/`deactivate` may also be async
  (ADR 0008). Without the `network.access` grant, `ctx.network` is a stub that
  rejects with a catchable error.
- **Permission-gated**: every privileged API checks a plugin's declared
  permissions (`renderer.css`, `renderer.script`, `renderer.dom`,
  `renderer.storage`, `electron.window`, `network.access`, …). CSS is
  treated as **data** and never executed as JS; there is no arbitrary page-JS
  execution bridge, and plugins cannot `fetch()` directly.
- **Layered architecture**: strict separation between Manager, Core, Injector,
  and Runtime (`docs/AGENTS.md`).

## How it works

```
Manager (Tauri GUI) ──► Core daemon (Rust)   local JSON-RPC over a socket
                              │
                              ▼
Target Electron app ◄── Injector (tronhawk_injector.dll, electron-hook)
       │   main process: Runtime boots, executes plugins in QuickJS
       └── renderer: data-only CSS + narrow host-owned page APIs
```

1. You register a target Electron app and install/enable plugins (with their
   permissions) in the **Manager**.
2. Launching the target goes through the **Injector** (a transparent
   launcher-wrapper / IFEO registration) which loads `tronhawk_injector.dll`
   into the target's main process via electron-hook.
3. The **Runtime** inside the target connects back to the **Core** daemon,
   receives the execution plan (which plugins are enabled and which
   permissions were granted), and runs renderer and main plugins in the QuickJS
   sandbox.
4. Renderer CSS is injected as data into each window; renderer JS can only call
   narrow host-owned operations; main plugins get window APIs through the
   TronHawk context — never raw Electron.

A fallback "launch with extensions" flow exists for apps that cannot use the
transparent-launch path.

## Supported Electron apps

Support is **tiered**, not binary (`docs/SPEC.md` §5):

| Level | Capability |
|---|---|
| 0 | **Unsupported** — hardened/ASAR-integrity targets, DRM/anti-cheat/banking software. No extension support, no guarantees. |
| 1 | **Renderer extension** — data-only CSS injection (+ runtime `css.insert`/`remove`), renderer JS via the QuickJS sandbox, DOM query/observe (serialized snapshots). |
| 2 | **Electron extension** — BrowserWindow through TronHawk APIs (`window`, lifecycle events, vibrancy/Mica); webContents / session / IPC are future. |

Targets include mainstream Electron apps (e.g. ChatGPT Desktop, Obsidian,
Discord). Compatibility is validated per app — see the real-target findings in
`docs/BACKLOG.md` and `docs/SPEC.md` §8 (validated: stock Electron 43.4.1
apps; Obsidian injection + renderer CSS/DOM with the full workspace rendering
in the Sep-2026 run; VS Code / ChatGPT-MSIX variants blocked by app
layout — tracked).

## Repository layout

```
crates/            Rust workspace
  core/            Core daemon: lifecycle, plugin parse, permission checks, IPC, storage
  injector/        Injector cdylib + launcher wrapper (wraps vendored electron-hook)
  runtime/         Plugin execution engine + QuickJS sandbox (JS bridge: crates/runtime/js)
  ipc/             JSON-RPC transport (versioned, structured errors)
  package/         .thx (ZIP) package mechanics — pack/extract + manifest validation
apps/
  manager/         Tauri GUI: apps, plugins, permissions, logs
  test-app/        Deterministic Electron fixture app used for dev + integration tests
sdk/               @tronhawk/sdk — TypeScript plugin API
plugins/           Example plugins (hello-world, dark-script, glass-window, ui-tweaks, window-effects)
tools/             create-tronhawk-plugin scaffolder
vendor/            Vendored third-party source (electron-hook + Detours)
docs/              SPEC, AGENTS, PLAN, BACKLOG, PLUGIN-SDK, PLUGIN-REGISTRY, adr/
tests/             Integration tests (pwsh tests/integration.ps1)
```

## Quickstart

### Prerequisites

- Windows 10/11 x64 (MVP platform) with the MSVC C++ build tools
- [Rust](https://rustup.rs) stable (MSVC host)
- [bun](https://bun.sh) ≥ 1.4 — the repo's JS toolchain (Node is not required)
- WebView2 runtime (for the Tauri Manager)
- PowerShell 7+ (`pwsh`) for the integration test

### Build the Rust workspace

```sh
bun install          # link the JS workspaces (sdk, plugins/*, tools/*)
cargo build --workspace
```

Build the runtime JS bundle (required once per fresh clone —
`crates/runtime/assets/runtime.js` is a gitignored build artifact):

```sh
cd crates/runtime/js && bun install && bun run build
```

### Run the tests

```sh
cargo test --workspace                # Rust unit tests

cd sdk && bun test && bun run typecheck   # SDK tests + typecheck
cd plugins/hello-world && bun run typecheck

pwsh tests/integration.ps1            # end-to-end: launch test-app via injector
```

### Try the SDK and example plugins

```sh
cd sdk && bun install && bun test
cd plugins/hello-world                # read manifest.json + src/ for the shape
```

### Run the Manager (Tauri GUI)

```sh
cd apps/manager
bun install
bun run tauri dev
```

To produce an app bundle (stages the Core sidecar first):

```sh
cd apps/manager && bun run bundle
```

### Run the deterministic test app (Electron)

```sh
cd apps/test-app
bun install
bun start
```

`apps/test-app` is the deterministic Electron fixture used for plugin
development and integration verification: a fixed `BrowserWindow`, renderer UI,
an IPC channel, a session, and dynamically added DOM.

## Create a plugin

Scaffold a plugin project with the `create-tronhawk-plugin` CLI (repo root):

```sh
bun run create-tronhawk-plugin -- plugins/foo --type renderer
# css | renderer (default) | main  → see tools/create-tronhawk-plugin/README.md
```

`plugins/foo` then has a `manifest.json` (id, name, version, author,
`tronhawk: "^0.1"` runtime-protocol range, `entry`, `permissions`), a
TypeScript starter, and a `style.css` for themes. The manifest declares the
permissions the plugin needs; the Manager shows them and the user grants them.
The full plugin API contract is in `docs/PLUGIN-SDK.md`.

Package a plugin as a `.thx` (ZIP) with the Rust packer:

```sh
cargo run -p tronhawk-package --bin pack -- plugins/foo foo.thx
```

The **plugin registry metadata format** — the catalog contract that will let a
future plugin store list plugins and have the Manager validate a downloaded
package against its metadata — is defined in `docs/PLUGIN-REGISTRY.md`. The
format is specified now; the store/catalog browsing and install-time integrity
cross-check are future work and not yet wired into the Manager.

## Security model

- **Plugins are untrusted.** They run in an embedded QuickJS sandbox — no
  `document`, `fetch`, `require`, or `process`; raw filesystem, process
  execution, and raw Electron/Node are never exposed without `runtime.unsafe`
  (developer mode — an opt-in, per-application exception; see `SECURITY.md`).
- **Permission gate.** Every privileged API checks the plugin's declared
  permissions first (see the table in `docs/PLUGIN-SDK.md`). Install never
  executes package code; the `.thx` manifest is validated and its extraction is
  zip-slip-guarded and archive-limited. Registry entry bytes are expected to be
  cross-checked against the downloaded package at install time — that cross-check
  is a planned contract, not yet wired into the Manager.
- **CPU bounds.** One-second deadline per evaluation/callback, memory and stack
  limits, and a cumulative-budget interrupt limit that hard-disables abusing
  plugins for the current plan generation.
- **No arbitrary page JS.** CSS is data injected via `insertCSS`; renderer
  script is restricted to host-owned operations (e.g. `setDocumentTitle` via a
  fixed assignment template). `docs/adr/0002-renderer-js-sandbox.md` records
  the full rationale.
- **No raw network.** Plugins cannot open sockets or `fetch()` directly;
  `ctx.network.request()` runs Core-side behind a permission check, a domain
  whitelist, and audit logging.

See `SECURITY.md` for the threat model, supported-app boundary, and how to
report a vulnerability.

## Status

| Phase | Deliverable | State |
|---|---|---|
| 0 | Foundation: Rust workspace, Tauri shell, SDK, test app | complete |
| 1 | Injection: vendored electron-hook, launcher/IFEO activation, comms | complete (validated on stock Electron 43.4.1) |
| 2 | Renderer plugins: `.thx` packaging, data-only CSS, hot reload | complete |
| 3 | QuickJS sandbox + main plugins: window APIs, permissions, CPU deadlines | complete |
| 4 | Manager UI: app/plugin/permission/logs | complete |
| 5 | **OSS prep: public docs, license/compliance, contribution guide** | in progress |

Implemented API surface vs. future work is spelled out at the top of
`docs/PLUGIN-SDK.md`; remaining follow-ups (webContents/session/IPC,
`network.proxy`, `.thx` signature verification, real-time log streaming/export,
real-target application profiles) are tracked in `docs/BACKLOG.md`.

## Documentation index

| Doc | Contents |
|---|---|
| `README_zh.md` | Chinese version of this README |
| `docs/SPEC.md` | Product & architecture spec (requirements, tiers, decisions) |
| `docs/AGENTS.md` | Binding AI/contributor development rules and module boundaries |
| `docs/PLAN.md` | Phased execution roadmap |
| `docs/BACKLOG.md` | Open follow-ups, resilience notes, real-target validation findings |
| `docs/PLUGIN-SDK.md` | Plugin API contract (contexts, permissions, lifecycle) |
| `docs/PLUGIN-REGISTRY.md` | Plugin registry metadata format |
| `docs/adr/` | Architecture decision records (injection backend, renderer JS sandbox) |
| `THIRD_PARTY_NOTICES.md` | Third-party license compliance pack |
| `CONTRIBUTING.md` | Build/test/dev workflow, commit conventions |
| `SECURITY.md` | Threat model and vulnerability reporting |

## License

TronHawk is **dual-posture licensed by component**:

- TronHawk's **own original code** is licensed under the **Apache License,
  Version 2.0** — see `LICENSE`. This does **not** cover third-party
  components.
- The distributed `tronhawk_injector.dll` **statically links electron-hook
  0.2.2 (LGPL-3.0)** and is therefore an **LGPL-3.0 Combined Work**, not a
  dynamically-linked exemption. The GNU GPL-3.0 text required by LGPL-3.0
  §4(b) is provided in `LICENSE.GPL-3.0`; the LGPL-3.0 text lives in
  `vendor/electron-hook/LICENSE`.

See `THIRD_PARTY_NOTICES.md` for the full compliance pack (notices, Minimal
Corresponding Source = `vendor/electron-hook/`, Corresponding Application Code
= `crates/injector/` + root `Cargo.toml`/`Cargo.lock`, and relink/build
instructions) and `NOTICE` for the provenance summary.

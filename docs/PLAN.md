# TronHawk — Development Plan

Complements `SPEC.md` (requirements) and `AGENTS.md` (binding rules). This is the execution
roadmap, phased to the milestones in SPEC §15.

## Status

- Phase 0 (Foundation) complete: Rust workspace, SDK, Tauri manager, Electron test-app all build
  and pass their tests.
- Post-review contract convergence applied: SDK public API frozen to the MVP surface; manager
  security baseline (CSP, no global Tauri, minimal capabilities); manager merged into the root
  workspace; CI now covers manager build, SDK/plugin typecheck, and the Electron fixture.
- Phase 1 (Injection) PoC validated: electron-hook (vendored) injects into a packaged Electron 43.4.1
  app — main-process + renderer (main world) capability confirmed; injector formalized with IFEO
  registration + transparent bootstrap. See docs/adr/0001-injection-backend.md.
- Phase 2 (Renderer plugins) complete: `.thx` ZIP packaging (pack/extract + strict manifest
  validation, zip-slip guarded, archive limits), transactional install (staging → `root/<id>`),
  multi-plugin execution plan (granted capabilities + revision), CSS injection (data-only), and
  revoke-safe hot reload. Renderer JS sandbox decided (ADR 0002: QuickJS, Phase 3).
- Toolchain: rustc/cargo 1.97.1 ✓, bun 1.4.0 ✓, Tauri CLI ✓ (via bun). Node not required — bun is
  the JS toolchain.

## Research-driven corrections (Aug 2026)

1. `electron-hook` is a **Rust crate** (`crates.io`, v0.2.2, LGPL-3.0), not an npm package. It
   injects a native `cdylib` via Microsoft Detours (`DetourCreateProcessWithDllExA`, suspended
   process) and remaps `app.asar` reads in memory — truly runtime-only, no disk writes. We must
   author our own `cdylib` + launcher on top of it.
2. Activation is **launcher-wrapper**, not self-attaching IFEO. Resolution: keep the IFEO
   "transparent launch" story, but IFEO's debugger key points at *our injector launcher*, which
   then launches the real target with Detours. SPEC §6/§8 wording needs this clarification.
3. **Main-process JS: full access.** **Renderer main-world JS: not turnkey** — must set
   `webPreferences.preload` from the main-process hook and handle `contextIsolation`/sandbox
   (resolves SDK Open Question #1). CSS injection works via stylesheet injection without main
   world.
4. Latest stable Electron is **43.x** (43.4.1, 2026-08-19). Target apps span many versions; treat
   Electron version fragmentation as a future-profile concern (SPEC §17).

## Phase 0 — Foundation (M0)

Objective: buildable skeleton. Acceptance: `cargo build`, `bun test`, `tauri dev`, test-app launches.

- **Toolchain:** install Node LTS (Electron tooling expects it) and Tauri CLI
  (`cargo install tauri-cli` or `@tauri-apps/cli` via bun).
- **Cargo workspace** at root: `crates/{core, injector, runtime, ipc, package}` as placeholder
  crates with correct crate names and empty `lib.rs` + `Cargo.toml`.
- **`apps/manager`**: Tauri app shell (empty window, `tauri dev` runs). No business logic in the
  Manager (AGENTS.md ownership rule).
- **`apps/test-app`**: minimal deterministic Electron app (one `BrowserWindow`, static renderer,
  an IPC channel, a session, dynamically-added DOM). This is the injection/CI target.
- **`sdk/`**: `@tronhawk/sdk` TS package with the public types (`PluginContext`, `RendererContext`,
  `MainContext`) as stubs; `bun test` green.
- **`plugins/`**: one `hello-world` example plugin dir.
- **CI**: GitHub Actions workflow — `cargo test` + `bun test` + build on push (Windows x64).
- **`tests/`**: empty integration harness placeholder.

Deliverable: skeleton builds on a clean machine.

## Phase 1 — Injection (M1)

Objective: launch test-app → auto-inject → hello-world plugin runs. Acceptance per SPEC §15.

- **`crates/injector`**: Rust `cdylib` wrapping `electron-hook`; the launcher exe; IFEO registration
  helper. Establishes comms (local socket) with Core. Must NOT contain plugin logic or permission
  decisions.
- **`crates/ipc`**: JSON-RPC over local socket; every message has `version` + request `id`;
  structured errors (AGENTS.md §IPC).
- **`bootstrap.js`**: minimal main-process bootstrap loaded by the injected `app.asar` redirect;
  boots our runtime.
- **PoC → ADR gate (SPEC §8, must pass before committing):**
  1. electron-hook renderer capability (isolated world vs main world).
  2. electron-hook main-process capability.
  3. Latest-Electron compatibility.
  4. Real targets: ChatGPT Desktop, VS Code.
- **Deliverable:** injector injects the test-app and a hello-world plugin executes; ADR records
  the renderer-world decision and any IFEO/launcher reconciliation.

## Phase 2 — Renderer plugins (M2)

Objective: `.thx` loads; CSS + JS renderer plugins work; CSS hot reload. Acceptance: ChatGPT dark theme.

- **`crates/package`**: `.thx` (ZIP) — validate manifest → check permissions → extract → register
  (install flow, no code execution during install).
- **`crates/runtime`** (renderer side): `ctx.css.insert/remove`, `ctx.dom.query/observe`,
  `ctx.script.execute`, each gated by `renderer.css` / `renderer.dom` / `renderer.script`.
- **CSS hot reload** (required) + optional JS reload.
- **Core permission check** before every renderer privileged call.
- Decide Open Question #3 (plugin dependency isolation) as part of package/loading design.

## Phase 3 — Main plugins (M3)

Objective: BrowserWindow APIs + permissions. Acceptance: ChatGPT glass window.

- **`crates/runtime`** (main side): `ctx.window.onCreated` + `setOpacity/setSize/setPosition`;
  lifecycle events (`onLoad`, `onUnload`, `onRendererReady`, `onWindowCreated`).
- **Permission checks** for `electron.window` (and future `webContents`/`session`/`ipc`).
- Decide Open Question #2 (main-runtime JS loading: Node VM vs QuickJS vs V8 isolate) via ADR.
- No main-process hot-unload in MVP (SPEC §17).

## Phase 4 — Manager UI (M4)

Objective: usable manager. Acceptance per SPEC §11/§16.

- Applications (supported level), Plugins (install/enable/disable/remove), Permissions view
  (requested vs not-requested, accept/reject/details), Logs (three streams).
- Config schema UI auto-generated from `manifest.json` `config{}`.
- Manager stays within its lane: UI + display only; it never injects or touches target processes.

## Phase 5 — OSS prep (M5)

- Public docs (purpose/API/permissions/examples), examples, contribution guide,
  `create-tronhawk-plugin` scaffolding CLI, plugin registry metadata format.

## Cross-cutting (every phase)

- **Permission model** lives in Core; implement incrementally, never bypass.
- **Logging**: Core / Runtime / Plugin streams, format `[Plugin ID][Level][Timestamp] message`.
- **Testing**: Rust `cargo test`, TS `bun test`; runtime features need `apps/test-app` integration
  (launch → inject → load → verify).
- **Docs**: each public feature updates `docs/` (purpose, API, permissions, examples).
- **Commits**: Conventional, small and focused.
- **Public-interface stability**: SDK, IPC protocol, manifest schema changes require doc +
  migration + version bump.

## Dependencies & sequencing

Linear spine: **M0 → M1 → M2 → M3 → M4 → M5**. M2 and M3 both depend on M1 (injection + comms).
M4 UI shell is scaffolded in M0 but its wiring lands after M2/M3. The M1 PoC/ADR gate is the
highest-risk choke point and must run early.

## Open decisions (confirm before/at the relevant phase)

1. **LGPL-3.0** on `electron-hook` — acceptable dependency posture? (Isolate it inside the
   Injector layer regardless.)
2. **Renderer world** for M2: isolated world (preload) vs main world (`contextIsolation:false`
   or `webFrame.executeJavaScript`) — decide at the M1 PoC.
3. **Main-runtime JS sandbox** (VM vs QuickJS vs V8) — decide at M3.
4. **Node LTS** install for Electron tooling — needed in Phase 0.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| electron-hook bus factor (single maintainer, LGPL) | high | keep it behind the Injector backend interface; never couple Core |
| ASAR integrity checks in hardened targets | high | detect + document unsupported (Level 0) |
| Sandboxed + contextIsolated renderers | medium | preload + `contextBridge`; main-world only when needed |
| Electron version fragmentation | medium | future application profiles (SPEC §18) |

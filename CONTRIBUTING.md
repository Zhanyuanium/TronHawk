# Contributing to TronHawk

Thanks for contributing! TronHawk is a runtime extension platform for Electron
apps: plugins run sandboxed and permission-gated, and the target app is never
modified on disk. Keep those invariants in mind in everything you touch.

Please read the binding project rules in `docs/AGENTS.md` before making
changes — especially the **module ownership boundaries** below — and use
`docs/SPEC.md` for requirements/decisions and `docs/PLUGIN-SDK.md` for the
public plugin API.

> Standalone plugin development uses the `@tronhawk/sdk` types + testing helpers
> and the standalone `@tronhawk/cli` (`tronhawk` binary) with the same-version
> `tronhawk-pack` engine — no TronHawk checkout needed (see `docs/PLUGIN-SDK.md`
> and `tools/create-tronhawk-plugin/README.md`). This guide covers developing
> TronHawk itself inside this monorepo (build, test, pack, bundle); the
> `cargo run -p` monorepo pack flow is a contributors-only alternative (from the
> repo root only).

## Prerequisites

- Windows 10/11 x64 with the MSVC C++ build tools
- Rust stable (MSVC host)
- bun ≥ 1.4 (the repo's JS toolchain; Node is not required)
- PowerShell 7+ (`pwsh`) for the integration test
- WebView2 runtime (to run the Manager)

## Setup

```sh
git clone <your-fork>
bun install                # link JS workspaces: sdk, plugins/*, tools/*
```

Build the runtime JS bundle first (gitignored artifact), then the
sidecars, stage them for the Manager, and only then build the full
workspace (`tauri-build` validates the staged `tauri.conf.json`
`externalBin`/`resources` paths):

```pwsh
Push-Location crates/runtime/js; bun install; bun run build; Pop-Location
cargo build -p tronhawk-core -p tronhawk-injector
Push-Location apps/manager; bun install; bun run stage:core; Pop-Location
cargo build --workspace
```

The Manager and test-app keep their own JS dependency trees:

```pwsh
Push-Location apps/manager; bun install; Pop-Location   # Tauri GUI
Push-Location apps/test-app; bun install; Pop-Location  # Electron fixture (downloads Electron)
```

## Running tests

Rust (requires the same runtime.js + sidecar staging as Setup above,
otherwise the Manager build script fails on the missing
`src-tauri/binaries/` paths):

```pwsh
cargo test --workspace
cargo build --workspace
```

TypeScript (SDK) and example plugins:

```pwsh
Push-Location sdk; bun test; bun run typecheck; Pop-Location
Push-Location plugins/ui-tweaks; bun run typecheck; Pop-Location
```

Scaffolder CLI (`tools/create-tronhawk-plugin`):

```pwsh
Push-Location tools/create-tronhawk-plugin; bun test; Pop-Location
```

Integration (launches `apps/test-app` through the injector against a real Core
daemon and verifies durable logs):

```sh
pwsh tests/integration.ps1
```

CI (`.github/workflows/ci.yml`) runs these same checks on push/PR:
`runtime.js` bundle build + `cargo build -p tronhawk-core
-p tronhawk-injector`, sidecar staging into
`apps/manager/src-tauri/binaries/`, then `cargo test --workspace` +
`cargo build --workspace` (Windows), SDK typecheck/tests +
example-plugin typecheck (bun), and the integration script (Windows).

## Development workflow

1. Understand the architecture and relevant APIs first (`docs/SPEC.md`,
   `docs/AGENTS.md`, `docs/PLUGIN-SDK.md`).
2. Prefer a focused feature branch; do not mix unrelated refactors into a
   change.
3. Implement against the module ownership boundaries (below). A feature that
   crosses a layer must keep each layer's responsibilities intact.
4. Ship tests with every feature: Rust `cargo test`, TS `bun test`, and an
   `apps/test-app` integration test for runtime features (launch → inject →
   load → verify).
5. Update docs for every public feature (purpose, API, permissions, examples).
6. Open a pull request against `main`.

## Module ownership boundaries (binding)

| Module | Location | Responsible for | Must NOT |
|---|---|---|---|
| Manager | `apps/manager` | UI, config UI, permission display | inject, execute plugins, touch target processes |
| Core | `crates/core` | lifecycle, plugin parse, permission check, IPC, storage | contain UI, depend on Electron internals |
| Injector | `crates/injector` | enter process, load bootstrap, establish comms | plugin logic, permission decisions |
| Runtime | `crates/runtime` | execute plugins, provide APIs, bridge to Electron | user / install management |

Support crates: `crates/package` (`.thx` format mechanics) and `crates/ipc`
(JSON-RPC transport) are owned by the Core layer — they never make permission,
install, or registration decisions.

Two rules to call out explicitly:

- **Core must not touch Electron.** No UI, no Electron-internal dependencies.
- **Manager must not inject.** The Manager only displays and configures; it
  never executes plugins, never injects, and never touches target processes.

Violations of these boundaries are architecture changes and will be rejected in
review.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/), small and
focused:

```text
feat(runtime): wire window.setOpacity through the QuickJS sandbox
fix(core): reject manifests with duplicate entry names
docs(sdk): document the implemented-vs-future API surface
test(package): cover case-fold zip entry collisions
```

Scope hints: `core`, `injector`, `runtime`, `ipc`, `package`, `manager`,
`sdk`, `plugins`, `tools`, `docs`, `ci`, `build`. One logical change per
commit; keep public interfaces (Plugin SDK, IPC protocol, manifest schema)
stable — changes require doc update + migration + version bump
(`docs/AGENTS.md`).

## PR review checklist

For every pull request, reviewers check that:

- [ ] The change stays inside its module's ownership boundary; no Core/Manager
      blur, no UI in Core, no injection in Manager.
- [ ] No permission check is bypassed or weakened; no new raw filesystem /
      process / raw Electron-Node exposure without `runtime.unsafe`.
- [ ] No target-app file modification and no undocumented Electron hacks.
- [ ] Tests are included and pass locally (`cargo test`, `bun test`, and the
      integration test where relevant).
- [ ] Public features update `docs/` (purpose, API, permissions, examples).
- [ ] Conventional Commits; no unrelated refactors mixed in.
- [ ] Errors are typed (`Result<T, E>`) and structured across module
      boundaries; no `unwrap()` in production paths.
- [ ] TypeScript public API is fully typed; imports come from
      `@tronhawk/sdk`; no hidden globals.
- [ ] Commits and files are free of secrets, absolute local paths, and
      `git diff --check` whitespace errors.

## Trying plugin changes end to end

Scaffold a scratch plugin, then load it through the Manager or the integration
harness:

```sh
bun run create-tronhawk-plugin -- plugins/my-scratch --type renderer
cargo run -p tronhawk-package --bin pack -- plugins/my-scratch my-scratch.thx
```

See `README.md` (Quickstart) and `docs/PLUGIN-SDK.md` for the API and
permissions. The deterministic Electron fixture `apps/test-app` is the
supported place to verify renderer behavior.

## Code of conduct

TronHawk community interactions are governed by the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
The full text is published as `CODE_OF_CONDUCT.md` in the repository root.
Harassment or other unacceptable behavior can be reported to the maintainers
(see `SECURITY.md` for the private reporting path).

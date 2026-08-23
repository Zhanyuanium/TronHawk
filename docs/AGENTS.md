# TronHawk — AI Development Guidelines

Binding rules for AI agents working on this repo. Preserve the core principles and module
boundaries; see `SPEC.md` for requirements/decisions and `PLUGIN-SDK.md` for the public API.

## Core principles (invariant)

1. Runtime-only modification — never alter target app files (exe, `app.asar`, resources, Electron, Chromium).
2. Permission-controlled extensions — plugins are untrusted; check permission before every privileged API.
3. Strict layering — Manager / Core / Injector / Runtime / Plugins must not blur responsibilities.

## Module ownership (binding)

| Module | Location | Responsible for | Must NOT |
|---|---|---|---|
| Manager | `apps/manager` | UI, config UI, permission display | inject, execute plugins, touch target processes |
| Core | `crates/core` | lifecycle, plugin parse, permission check, IPC, storage | contain UI, depend on Electron internals |
| Injector | `crates/injector` | enter process, load bootstrap, establish comms | plugin logic, permission decisions |
| Runtime | `crates/runtime` | execute plugins, provide APIs, bridge to Electron | user / install management |

## Coding principles

- Prefer abstraction over implementation — expose `window.set_vibrancy()`, never Electron private symbols unless approved.
- No premature generalization — do NOT build app profiles, marketplace, native-hook framework, or Chromium
  replacement before MVP.
- Keep public interfaces stable (Plugin SDK, IPC protocol, manifest schema). Changes require doc + migration + version bump.

## Language rules

- **Rust:** stable; idiomatic ownership; explicit errors (`Result<T, E>`); no `unwrap()` in production paths;
  errors crossing module boundaries carry type + human-readable message + context; async only when needed.
- **TypeScript:** public API must be fully typed; no hidden globals (`window.tronhawk`); import types from `@tronhawk/sdk`.

## Security (binding)

- Assume plugin code is untrusted. Verify permission before execution.
- Never expose raw filesystem, process execution, or raw Electron/Node without `runtime.unsafe`.
- Never execute arbitrary package code during install; never trust unvalidated metadata.

## IPC & package format

- IPC: JSON-RPC over local socket; every message has a `version` and request `id`; errors return structured responses.
- Package `.thx` = ZIP. Install flow: receive → validate manifest → check permissions → extract → register.

## Testing (required)

- Every feature ships tests: Rust `cargo test`, TS `bun test`.
- Runtime features need an integration test via `apps/test-app` (launch → inject → load plugin → verify).
- Keep `apps/test-app` a deterministic Electron env: BrowserWindow, renderer UI, IPC, session, dynamic DOM.

## Documentation & commits

- New public feature ⇒ update `docs/` (purpose, API, permissions, examples).
- Conventional commits, small and focused: `feat(runtime): …`, `fix(core): …`.

## Forbidden

- **Architecture:** merge Core+Runtime; put UI logic in Core; put injection logic in Manager.
- **Security:** disable permission checks; expose raw filesystem / process.
- **Scope:** native hooks; modify target app files; undocumented Electron hacks.

## Priority

Correctness > Architecture > Maintainability > Performance > Convenience.

## MVP = done only when

1. Manager launches. 2. Test app is injectable. 3. `.thx` loads. 4. Renderer CSS plugin works.
5. Renderer JS plugin works. 6. Permission system works. 7. Logs are available.

## Workflow (every task)

1. Understand architecture / APIs / tests → 2. Plan (files, reason, risks) → 3. Implement (no unrelated refactor)
→ 4. Test (`cargo test`, `bun test`) → 5. Update docs.

## Deferred (not MVP)

Application profiles, Explorer mode, plugin marketplace UI, native hooks, CEF support, macOS/Linux activation.

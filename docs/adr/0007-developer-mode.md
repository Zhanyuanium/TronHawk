# ADR 0007 — Developer mode (`runtime.unsafe`): opt-in raw host execution

Status: **Accepted** (implemented; SDK 0.3.0 adds the optional `raw?: RawAPI`)

## Context

SPEC §9/§10 always listed `runtime.unsafe` as the theoretical path to raw Electron/Node, but nothing
enabled it: no capability list included the permission and no toggle existed, so the surface was dead
(BACKLOG: "parsed but permanently unreachable"). Meanwhile the QuickJS sandbox (ADR 0002) is the only
execution path for plugin code, and its synchronous host-function model cannot host async host APIs
(pending-job draining is unimplemented — `ctx.dom`, `ctx.network`, `ctx.session`, `ctx.ipc` are typed
but future). That leaves no sandboxed way to express a whole class of real, developer-driven
extensions that need genuine Node/Electron parity today.

Open question: keep `runtime.unsafe` as a permanent dead surface, or wire developer mode for real.

## Options evaluated

| Option | Raw Electron/Node today | Sandbox stays the default | Risk controlled by | Future path |
|---|---|---|---|---|
| **A — Opt-in developer mode (`runtime.unsafe`)** | ✅ real, host-process execution | ✅ off by default | explicit Manager toggle + per-application grant; purge on disable | async host APIs land → guide normal plugins back to sandboxed APIs |
| **B — Stay sandbox-only; leave the surface dead** | ❌ | ✅ | — | wait indefinitely for async host APIs before any parity feature |

## Decision

Adopt **Option A**: developer mode is a real, **off-by-default**, explicitly user-opted exception.

1. **Toggle.** Developer mode is turned on/off in the Manager Settings view. It is stored as the
   persisted `global.developerMode` flag (default `false`) and every change logs
   `core.developerMode.updated`. The toggle is control-token-only and idempotent.
2. **Interlock with support level.** Developer mode never bypasses the support level. `runtime.unsafe`
   is grantable only while developer mode is on **AND** the target app is **support level 2**
   (Electron extension). Level 0/1 apps never receive `runtime.unsafe`, even with developer mode on.
3. **Per-application grant.** Granting `runtime.unsafe` for a plugin remains a per-application policy
   decision; developer mode merely makes the permission *grantable*, it does not grant it.
4. **Purge on disable.** Disabling developer mode purges `runtime.unsafe` from every application's
   plugin policy grants (message: "Developer mode disabled; runtime.unsafe grants revoked"), so
   turning developer mode off also revokes previously granted unsafe capability on the next plan.
5. **Reject Option B.** Leaving the surface dead removes a genuine developer use-case until
   unimplemented async host APIs land, with no mitigation for the gap. Option A ships the capability
   inside an explicit, revocable grant while the sandboxed API surface catches up.

## Design (what is implemented)

- **Granting.** With developer mode on, the Level-2 capability set becomes `renderer.css`,
  `renderer.script`, `electron.window`, plus `runtime.unsafe`. Without it, `runtime.unsafe` cannot be
  granted. The execution plan ships the plugin with `runtime.unsafe` granted and its source intact
  (the permission unlocks `main`/`renderer` payloads instead of filtering the plugin out).
- **Execution.** A plugin whose `granted` includes `runtime.unsafe` bypasses the QuickJS sandbox
  entirely: its `main`/`renderer` source runs in the **host main process** via `new Function`
  (`crates/runtime/js/src/index.js`, `runRawPlugin`). The host `require`, `process`, and
  `require("electron")` are bound as the frame's own parameters, plus `ctx` and a CommonJS
  `module`/`exports`.
- **Surface.** `ctx.raw.electron` is the real Electron module of the injected app; `ctx.raw.node` is
  `{ require, process }` — the real Node runtime. `ctx.raw` is **never** present on a sandboxed
  plugin's context.
- **No sandbox limits.** There is no QuickJS VM, no one-second CPU deadline, no memory limit, and no
  stack limit. Execution is synchronous in the host main process.
- **Lifecycle.** Raw plugins follow the same synchronous `activate`/`deactivate(ctx)` contract and
  the same plan-generation / window guards as QuickJS plugins; there is no VM to dispose. Removing
  the `runtime.unsafe` grant in a new plan deactivates the raw plugin and drops it from the runtime's
  map.
- **SDK.** SDK 0.3.0 adds the optional `raw?: RawAPI` on the plugin context (`RawAPI.electron:
  unknown`, `RawAPI.node: { require, process }`).

## Security boundary

Arbitrary code execution is **intentional and user-consented** — it is the point of the feature, and
it is why the feature is shaped the way it is:

- **Off by default**; developer mode must remain off by default.
- **Two independent gates**: an explicit Manager toggle **and** a per-application `runtime.unsafe`
  grant; the grant additionally requires the app to be support level 2.
- **Disable purges**: turning developer mode off revokes every `runtime.unsafe` grant.
- **Never sandboxed**: `runtime.unsafe` execution must never be described as sandboxed (binding in
  `docs/AGENTS.md`). It is equivalent to running the plugin's code as part of the target app.

## Consequences

- SPEC §9/§10/§12, `PLUGIN-SDK.md`, `PLUGIN-REGISTRY.md`, `SECURITY.md`, `README.md`, and
  `docs/AGENTS.md` now document developer mode as a real, opt-in, critical-risk exception.
- New BACKLOG residuals: raw plugins have no CPU deadline (an unbounded synchronous loop can hang the
  target main process — accepted; needs a `test-app` raw integration test), and once async host APIs
  land, normal plugins should be guided back to the sandboxed APIs.
- Future sandboxed host APIs (`ctx.dom`, `ctx.network`, async host functions) remain the target
  surface; raw execution is the interim for the gap Option B refused to paper over.

## References

- ADR 0002 (QuickJS sandbox, CPU deadline) — the boundary developer mode deliberately opts out of.
- ADR 0001 (injection backend) — why raw plugin code runs in the injected app's main process.
- SPEC §9 (execution contexts), §10 (permissions), §12 (data & config); `PLUGIN-SDK.md`
  ("Developer mode"); `SECURITY.md` ("Developer mode (`runtime.unsafe`) is a deliberate exception");
  `docs/AGENTS.md` (Security, binding).
- Code: `crates/core/src/daemon.rs` (`set_developer_mode`, developer capability sets),
  `crates/runtime/js/src/index.js` (`runRawPlugin`), `sdk/src/index.ts` (`RawAPI`).

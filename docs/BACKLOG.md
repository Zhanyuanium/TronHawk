# Backlog

Known follow-ups and deferred items, tracked outside the milestone plan. Keep this updated as
work lands or new gaps are found. Items checked off here are genuinely unresolved; items that were
completed or superseded are no longer listed.

## Phase 3 — QuickJS sandbox (functionally complete; these remain)

- [ ] `ctx.dom.query` / `ctx.dom.observe` (`renderer.dom`) — needs async host functions; current
      sync QuickJS variant cannot drain pending jobs nor host async APIs. Exits: switch to the
      `asyncify` variant (single in-flight async per WASM module, size/speed cost) or run the sync
      VM on a `worker_thread`/`utilityProcess` and bridge over IPC. No decision yet.
- [ ] Once async host APIs land (`ctx.dom`, `ctx.network`, …), guide normal plugins back to the
      sandboxed APIs — raw host execution (`ctx.raw`, `runtime.unsafe`, ADR 0007) is the
      developer-mode interim, not the target surface. `ctx.config` is now available in the sandbox;
      only async host APIs (dom/network) remain.
- [ ] MainContext `setVibrancy` / `setMica` (true glass effect) — not wired; only
      `setOpacity` / `setSize` / `setPosition` are implemented.
- [x] Plugin `deactivate(ctx)` lifecycle — resolved: the runtime now invokes the plugin's exported
      `deactivate` (synchronously, returning `undefined` enforced, double-revoke guarded) before
      disposing the VM, for both main and renderer plugins.
- [ ] QuickJS pending-job draining — required before lifecycle hooks may return promises; the
      SDK contract currently enforces synchronous `void` (do not broaden until this lands).
- [ ] Real-target compatibility — generic **compat adapter** interface landed (Phase A,
      `crates/runtime/js/src/adapters`, ADR 0003); Obsidian's blocker root-caused and fixed at the
      injection layer (ADR 0004: merged asar, so `app.getAppPath()`/module resolution serve real
      files). The broader *application profiles* (recognition, per-app plugin UX, Manager UI) remain
      deferred (SPEC §18). Remaining for Obsidian: confirm the workspace mounts under the merged
      asar on a real run, then Path A (adapter `renderer.gate` injects once `.workspace` mounts);
      WorkBuddy not yet validated.

## Phase 4 — Manager UI (functional; these remain)

- [x] `manifest.json` `config{}` settings UI — resolved: manifest `config{}` schemas (fields with
      `type` string/number/boolean, optional `default`/`label`, ≤32 keys) are validated at
      pack/install; per-application × per-plugin values are stored in Core, merged into the
      per-plugin plan snapshot, and edited via the Manager's schema-driven settings form. Editing
      config bumps the plan revision so the runtime reloads the plugin with the new values. See
      SPEC §9/§12 and PLUGIN-SDK.md §Config.
- [ ] Real-time log push/streaming (current Logs view is manual refresh, read-only pagination).
- [ ] Structured log export/full-text search; per-plugin log credentials for stronger attribution.

## Resilience / availability (DUR-1 and CORE-3 resolved)

- [x] **DUR-1 — Core restart / OS suspend permanently orphans every running target.** Resolved:
      launch tokens are now self-contained HMAC-signed (`v1.<app>.<issued>.<nonce>.<mac>` over a
      separate persistent `launch.key`); no in-memory session map. A token authorizes plan/log RPCs
      while <600s old and `renewSession` refreshes it up to one 24h absolute cap. The bootstrap
      transport proactively renews (>540s) and passively recovers on `-32001`, so a target survives
      a Core restart or long suspension without relaunching. Verified end-to-end (kill + restart Core
      on the same root/port while the target stays alive; 'Core reconnected' observed).
      Residual (accepted): >24h offline targets must relaunch; same-user can read `launch.key` to
      mint tokens for registered apps (equivalent to reading `control.token`, no privilege widening).
- [x] **CORE-3 — daemon re-reads every installed plugin's full source on each `getExecutionPlan`.**
      Resolved: `ServiceInner.plugin_cache` holds a content-fingerprint (relpath/size/mtime_ns) of the
      installed plugins and serves the parsed set on a hit; invalidation on install/remove. A rescan
      failure after a fingerprint change logs `core.plugin.scan_failed` and falls back to the last good
      cache (availability-first); per-app policy/plan filtering still applied each call.

## Package / install hardening

- [x] `tronhawk` host-version compatibility check — resolved: `validate_tronhawk_protocol` matches
      the plugin's `tronhawk` `VersionReq` against the host runtime protocol version
      (`HOST_PROTOCOL_VERSION` const + `_for_host` variants); incompatible plugins are rejected
      before any write.
- [x] Archive hardening — resolved: reject duplicate entry names, case-fold collisions, Windows
      reserved names, trailing dot/space segments, and NTFS ADS syntax, all fail-at-start before any
      write; `safe_join` applied to every entry.
- [x] Compression-ratio limit — resolved: per-entry and cumulative ratio guard rejects zip bombs
      that stay under the existing byte caps.
- [ ] Error enum (`Result<T, PackageError>` / `CoreError`) replacing `String` errors.

## Runtime correctness

- [x] Runtime remove-failure retry — resolved: `removeInsertedCSS` gets a bounded 3-attempt retry;
      final failure logs an error and re-registers the key so a later reconcile retries instead of
      silently dropping stale CSS (window destroyed mid-removal short-circuits cleanly).
- [ ] CPU-deadline residual: a single never-returning synchronous op in a plugin can still not be
      forcibly reclaimed mid-stack; the interrupt-count anti-catch mitigation covers loops that
      unwind the interrupt but not an op that truly never yields. Honest limitation; watch for a
      worker/watchdog path later.
- [ ] Raw-plugin (`runtime.unsafe`) unbounded synchronous loop — developer-mode execution has **no
      CPU deadline**, so a never-returning synchronous loop can hang the target main process
      indefinitely. Accepted residual of developer mode (ADR 0007); a `test-app` raw integration
      test is needed to load a raw plugin end-to-end and lock in the expected behavior.

## Distribution / compliance

- [ ] **LGPL-3.0 dynamic-linking compliance** — `electron-hook` is statically merged into
      `tronhawk_injector.dll`, so the obligation is LGPL §4(d)0 relinkability (there is no separate
      "static-linking exception"). Must provide Minimal Corresponding Source + install/link info
      sufficient to relink, plus license notices (GPL-3.0 + LGPL-3.0 text) with any MSI/NSIS
      distribution; avoid an EULA clause that forbids reverse-engineering for debugging. Detours is
      MIT (notice only). See `THIRD_PARTY_NOTICES.md`.

## Real-target validation (Aug 2026)

- [ ] **OpenChamber** (Electron 43.3.0) — original app fails to start: the modded asar
      `package.json` lacks a `version`, so `app.getVersion()` falls back to the exe's 4-part
      `1.22.0.0`, which electron-updater rejects. Confirmed Electron behavior. Mitigation: copy the
      original asar's `version`/`name`/`productName` into the modded asar (`make_package_json` in
      vendored electron-hook).
- [ ] **ChatGPT/Codex** — MSIX + a custom "owl" Electron fork; GUI does not start under raw-exe
      Detours launch (needs AUMID). Application-profile concern.
- [ ] **Generic Window Controls Overlay (WCO) elimination adapter** — landed a generic
      `onWindowOptions` adapter seam + `applyWindowOptions` (fail-open) so an adapter can rewrite
      every `new BrowserWindow(opts)` the target main process issues. The `wco` adapter drops
      `titleBarOverlay` and forces `titleBarStyle:"hidden"` (no native min/max/close buttons; no
      self-drawn controls). Validated against the TronHawk test-app (which simulates a WCO window
      on Windows). Real-target note: VS Code / WorkBuddy use WCO but are **unpacked apps (no
      `resources/app.asar`)**, which the ASAR-remap injection path cannot reach — so the WCO-
      elimination mechanism is proven on the test-app, and real VS Code validation is gated on the
      unresolved unpacked-app injection concern (ADR 0001/0004).

## Newly tracked / observations

- [ ] **`tests/integration.ps1` end-to-end gate fails in this environment — injection not reaching
      the target.** Core events arrive (launch_session/policy/registered) and the target process
      spawns, but the injected `bootstrap.js` never runs (a module-entry marker file is never
      written) and no Runtime/Plugin events are recorded. This is an **environment-level
      `electron-hook`/Detours injection failure**, NOT a regression from the Tier0/DevMode work: a
      `git stash` to the pre-change baseline reproduces the identical failure. Investigate
      separately (e.g. Detours/Exploit Protection / antivirus interference, or the vendored
      electron-hook build against Electron 43.4.1) before relying on this test as a gate. Unit +
      SDK + CLI + plugin typecheck suites all pass.
- [ ] **SEC-1 relay residual (accepted-in-threat-model).** `getServerProof` is unauthenticated, so
      a process that can reach an already-running real daemon could obtain proofs. The primary
      port-squat scenario (impostor binds before Core starts) has no daemon to relay to, so the
      defense holds; a relay needs simultaneous port occupancy and a running real Core, which
      requires already reading the control token. Recorded as accepted residual.
- [ ] **SEC-2 — launch token inherited by target child processes** via `TRONHAWK_IPC_SECRET`
      env. Acceptable today (plugins sandboxed, target trusted); long-term hand off via a dedicated
      FD/socketpair rather than env.
- [x] **developerMode / `runtime.unsafe`** — resolved (ADR 0007): developer mode is real. Off by
      default, it is toggled in the Manager Settings view (`core.developerMode.updated` is logged);
      `runtime.unsafe` becomes grantable only while developer mode is on AND the app is support level
      2, and disabling developer mode purges every `runtime.unsafe` grant. A granted plugin runs its
      `main`/`renderer` source in the host main process via `new Function`, receiving the real
      Node/Electron environment (`ctx.raw.electron` / `ctx.raw.node`) — no QuickJS sandbox, no CPU
      deadline, no memory/stack limits.
- [ ] Workspace `cargo fmt --all --check` drift (pre-existing, out of scope for this batch):
      `apps/manager/src-tauri/src/lib.rs:171`, `crates/injector/src/registry.rs`,
      `crates/package/src/lib.rs`, `vendor/electron-hook/**`. Needs a format-only pass by owners.
- [ ] **Launcher `.asar.unpacked` junction (non-fatal for Obsidian).** The injector launcher logs
      `failed to link app.asar.unpacked: mklink /J reported success but ... is not a junction` for
      Obsidian (its `app.asar` has an `.unpacked` dir). Obsidian has no critical native module there,
      so it still launches; targets with native modules (e.g. `better-sqlite3`) may fail to load them
      if the merged `*.asar.unpacked` is not a valid junction to the real `app.asar.unpacked`.
      Investigate the reparse-aware reconciliation (whether the created junction is validated against a
      canonicalized path that differs from the `mklink` target) before relying on it for
      native-module targets.
- [ ] **IFEO transparent launch (external double-click) is limited/unreliable.** With a target's IFEO
      `Debugger` set to the injector launcher, launching the target from outside (double-click) routes
      to the launcher, whose `electron_hook::launch` then creates the target again — Windows re-applies
      the IFEO `Debugger` to that creation, causing an infinite launcher re-entry loop. A
      `DEBUG_ONLY_THIS_PROCESS` recursion-guard bypass (create as a short-lived debuggee, pump to the
      loader breakpoint, detach) was implemented and stopped the loop, but the target (Obsidian) then
      did not survive (likely debug-loop/detach timing interacting with the Detours injection, or the
      injected DLL's asar remap). It was reverted. **Launch-with-extensions (from the Manager) is the
      reliable path**; the IFEO toggle remains but external transparent launch is known-limited until
      the debug-event/injection-timing interaction is resolved.

# Backlog

Known follow-ups and deferred items, tracked outside the milestone plan. Keep this updated as
work lands or new gaps are found. Items checked off here are genuinely unresolved; items that were
completed or superseded are no longer listed.

## Phase 3 — QuickJS sandbox (functionally complete; these remain)

- [x] Async host functions (`ctx.dom`, `ctx.network`, `ctx.storage`, async lifecycle) — resolved
      (ADR 0008): the synchronous QuickJS VM stays in-process and the runtime adds a host-driven
      pending-job pump (`vm.newPromise()` + `executePendingJobs()`). `ctx.dom.query` returns a
      Promise of a serialized `DomElement` snapshot (the old synchronous `Element | null` is
      re-specified — a real DOM `Element` cannot cross the QuickJS boundary), `ctx.dom.observe` is a
      ~100 ms polling bridge delivering snapshots, `ctx.network.request` is a Core-side
      domain-whitelisted fetch with a catchable rejection, `ctx.storage` is renderer-only
      host-namespaced storage (`tronhawk:<pluginId>:<key>`), and `activate`/`deactivate` may return
      a Promise the runtime drains. Lifecycle-event and `observe` callbacks stay synchronous
      `undefined`. SDK 0.5.0.
- [x] Guide normal plugins back to the sandboxed APIs — resolved (ADR 0008): `ctx.dom`,
      `ctx.network`, `ctx.storage`, and async lifecycle now run inside the sandbox. Raw host
      execution (`ctx.raw`, `runtime.unsafe`, ADR 0007) remains the documented developer-mode
      interim only for capability beyond the sandboxed surface.
- [x] MainContext `setVibrancy` / `setMica` (true glass effect) — resolved: the runtime wires both
      host functions (macOS `setVibrancy`, Windows 11 `setBackgroundMaterial`; structured-log no-op
      elsewhere); SDK + docs mark them implemented.
- [x] Plugin `deactivate(ctx)` lifecycle — resolved: the runtime now invokes the plugin's exported
      `deactivate` (double-revoke guarded) before disposing the VM, for both main and renderer
      plugins; a returned Promise is drained (ADR 0008).
- [x] Runtime-callable `ctx.css.insert` / `ctx.css.remove` — resolved: renderer plugins holding
      `renderer.css` can inject/revoke stylesheets at runtime (bounded remove retry); `ctx.network`
      is now always present (denying stub without `network.access`), closing the SDK required-field
      drift.
- [x] QuickJS pending-job draining — resolved (ADR 0008): the runtime now drains pending jobs
      (`executePendingJobs()`) around host-async operations and at `activate`/`deactivate`, so the
      SDK contract broadens from synchronous `void` to `void | Promise<void>` for lifecycle hooks
      only. Event/`observe` callbacks remain synchronous (never drained).
- [ ] Real-target compatibility — generic **compat adapter** interface landed (Phase A,
      `crates/runtime/js/src/adapters`, ADR 0003); Obsidian's blocker root-caused and fixed at the
      injection layer (ADR 0004: merged asar, so `app.getAppPath()`/module resolution serve real
      files). The broader *application profiles* (recognition, per-app plugin UX, Manager UI) remain
      deferred (SPEC §18). Obsidian workspace mount confirmed on a Sep-2026 real run (full note
      UI rendered; Path A `renderer.gate` fired on `.workspace`); WorkBuddy not yet validated.

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
      vendored electron-hook). Update: under the merged asar (Path I) the modded `package.json`
      comes from the real app (which carries a version), so this may already be resolved — needs a
      real re-run to confirm.
- [ ] **ChatGPT/Codex** — MSIX + a custom "owl" Electron fork; GUI does not start under raw-exe
      Detours launch (needs AUMID). Application-profile concern.
- [ ] **Generic Window Controls Overlay (WCO) elimination adapter** — landed a generic
      `onWindowOptions` adapter seam + `applyWindowOptions` (fail-open) so an adapter can rewrite
      every `new BrowserWindow(opts)` the target main process issues. The `wco` adapter drops
      `titleBarOverlay` and forces `titleBarStyle:"hidden"` (no native min/max/close buttons; no
      self-drawn controls). **Interception point (ADR 0009):** `require("electron").BrowserWindow`
      is a configurable:false, getter-only accessor, so directly assigning it silently no-ops; the
      runtime instead wraps `require("module")._load` to hand out a Proxy facade whose
      `BrowserWindow` getter returns the wrapping constructor. Verified end-to-end on real Electron
      against the TronHawk test-app (WCO simulation): control shows the native overlay buttons, the
      injected run hides them. Real-target note: VS Code / WorkBuddy use WCO but are **unpacked
      apps (no `resources/app.asar`)**, which the ASAR-remap injection path cannot reach — so the
      WCO-elimination mechanism is proven on the test-app, and real VS Code validation is gated on
      the unresolved unpacked-app injection concern (ADR 0001/0004 / ADR 0009).

## Newly tracked / observations

- [x] **`tests/integration.ps1` end-to-end gate fails in this environment.** Resolved: the root
      cause was a stale `target/debug/tronhawk-sidecar.json` from an old `--aumid` probe — the
      injected DLL's `DllMain` re-applied it and clobbered the fresh env, so `bootstrap()` never
      ran. Fixed structurally (the launcher deletes the sidecar after a successful `--aumid`
      attach); the gate now passes on `main`, including DUR-1 restart-reconnect.
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
      14 files ~100 spots, incl. `crates/core/src/daemon.rs`, `crates/injector/src/bin/launcher.rs`,
      `crates/injector/src/asar_merge.rs`, `crates/package/src/lib.rs`,
      `apps/manager/src-tauri/src/core_client.rs`, `vendor/electron-hook/**`. Needs a format-only
      pass by owners.
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

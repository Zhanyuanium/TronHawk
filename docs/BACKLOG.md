# Backlog

Known follow-ups and deferred items, tracked outside the milestone plan. Keep this updated as
work lands or new gaps are found. Items checked off here are genuinely unresolved; items that were
completed or superseded are no longer listed.

## Phase 3 — QuickJS sandbox (functionally complete; these remain)

- [ ] `ctx.dom.query` / `ctx.dom.observe` (`renderer.dom`) — needs async host functions; current
      sync QuickJS variant cannot drain pending jobs nor host async APIs. Exits: switch to the
      `asyncify` variant (single in-flight async per WASM module, size/speed cost) or run the sync
      VM on a `worker_thread`/`utilityProcess` and bridge over IPC. No decision yet.
- [ ] MainContext `setVibrancy` / `setMica` (true glass effect) — not wired; only
      `setOpacity` / `setSize` / `setPosition` are implemented.
- [ ] Plugin `deactivate(ctx)` lifecycle — runtime disposes the QuickJS VM but does not call the
      plugin's own `deactivate`.
- [ ] QuickJS pending-job draining — required before lifecycle hooks may return promises; the
      SDK contract currently enforces synchronous `void` (do not broaden until this lands).
- [ ] Real-target compatibility (application profiles, SPEC §18): Obsidian renders shell-only via a
      custom `app://` protocol; WorkBuddy not yet validated. All deferred.

## Phase 4 — Manager UI (functional; these remain)

- [ ] `manifest.json` `config{}` settings UI — schema-driven auto-generated Manager form; config
      state exists in Core but no UI.
- [ ] Real-time log push/streaming (current Logs view is manual refresh, read-only pagination).
- [ ] Structured log export/full-text search; per-plugin log credentials for stronger attribution.

## Resilience / availability (found in the post-M4 audit — genuinely open)

- [ ] **DUR-1 — Core restart / OS suspend permanently orphans every running target.** Launch
      sessions are in-memory only; after any Core restart (or >10min idle suspension) the target's
      bootstrap polls forever with `-32001`, freezing its plan and dropping logs. No re-attach path.
      Investigate a launcher-side session renewal keyed to the app or persisted sessions with
      durable `last_used`. This is a real enforcement gap for policy/revocation.
- [ ] **CORE-3 — daemon re-reads every installed plugin's full source on each `getExecutionPlan`.**
      Each injected app polls every 2s; disk I/O scales with apps x plugins. `CachedLoader` was
      removed as dead code; re-instate a content-fingerprint cache in the live daemon path.

## Package / install hardening

- [ ] `tronhawk` host-version compatibility check — `VersionReq::matches` against the runtime
      protocol version (currently only syntax-validated).
- [ ] Archive hardening — duplicate entry names, case-fold collisions, ADS / reserved names,
      trailing dot/space.
- [ ] Compression-ratio limit (defend against zip bombs beyond the uncompressed-size cap).
- [ ] Error enum (`Result<T, PackageError>` / `CoreError`) replacing `String` errors.

## Runtime correctness

- [ ] Runtime remove-failure retry (don't swallow `removeInsertedCSS` errors).
- [ ] CPU-deadline residual: a single never-returning synchronous op in a plugin can still not be
      forcibly reclaimed mid-stack; the interrupt-count anti-catch mitigation covers loops that
      unwind the interrupt but not an op that truly never yields. Honest limitation; watch for a
      worker/watchdog path later.

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

## Newly tracked / observations

- [ ] **SEC-1 relay residual (accepted-in-threat-model).** `getServerProof` is unauthenticated, so
      a process that can reach an already-running real daemon could obtain proofs. The primary
      port-squat scenario (impostor binds before Core starts) has no daemon to relay to, so the
      defense holds; a relay needs simultaneous port occupancy and a running real Core, which
      requires already reading the control token. Recorded as accepted residual.
- [ ] **SEC-2 — launch token inherited by target child processes** via `TRONHAWK_IPC_SECRET`
      env. Acceptable today (plugins sandboxed, target trusted); long-term hand off via a dedicated
      FD/socketpair rather than env.
- [ ] **developerMode / `runtime.unsafe`** — parsed but permanently unreachable (nothing enables
      developer mode, no capability list includes `runtime.unsafe`). Decide whether to wire a
      developer-mode toggle for real (feature signal) or remove the dead spec surface.
- [ ] Workspace `cargo fmt --all --check` drift (pre-existing, out of scope for this batch):
      `apps/manager/src-tauri/src/lib.rs:171`, `crates/injector/src/registry.rs`,
      `crates/package/src/lib.rs`, `vendor/electron-hook/**`. Needs a format-only pass by owners.

# Backlog

Known follow-ups and deferred items, tracked outside the milestone plan. Keep this updated as
work lands or new gaps are found.

## Phase 3 — QuickJS sandbox (complete)

- [ ] `ctx.dom.query` / `ctx.dom.observe` (`renderer.dom`) — needs async host functions (the
      `asyncify` QuickJS variant) + a per-window DOM bridge returning serialized data.
- [ ] `MainContext.setVibrancy` / `setMica` (true glass effect) — not yet wired; only
      `setOpacity` / `setSize` / `setPosition` are implemented.
- [ ] Plugin `deactivate(ctx)` lifecycle — the runtime currently only disposes the QuickJS `vm`;
      it does not invoke the plugin's own `deactivate`.
- [ ] QuickJS pending-job draining — required before lifecycle hooks may return promises and before
      asynchronous host APIs can expose completion/results to plugins.

## Phase 4 — Manager UI

- [ ] `manifest.json` `config{}` settings UI — schema-driven auto-generated Manager form; not
      implemented (config state exists in Core but no UI).
- [ ] Real-time log push/streaming (current Logs view is manual refresh, read-only pagination).
- [ ] Structured log export/full-text search; per-plugin log credentials for stronger attribution.

## Package / install hardening

- [ ] `tronhawk` host-version compatibility check — `VersionReq::matches` against the runtime
      protocol version (currently only syntax-validated).
- [ ] Per-plugin install lock (concurrent installs of the same ID).
- [ ] Archive hardening — duplicate entry names, case-fold collisions, ADS / reserved names,
      trailing dot/space.
- [ ] Compression-ratio limit (defend against zip bombs beyond the uncompressed-size cap).
- [ ] Error enum (`Result<T, PackageError>` / `CoreError`) replacing `String` errors.

## Core / protocol

- [ ] Multi-plugin orchestration — Core currently loads one plugin; `ExecutionPlan` already
      supports an array.
- [ ] `CachedLoader` content hash — the fingerprint is metadata-only (same size + same mtime
      content changes can be missed); consider hashing bytes or a watcher.
- [ ] Navigation re-injection — verify CSS/renderer plugins re-apply after in-app navigation
      (`did-finish-load` fires on navigation too).
- [ ] Runtime remove-failure retry (don't swallow `removeInsertedCSS` errors).

## Distribution / compliance

- [ ] LGPL-3.0 dynamic-linking compliance review (electron-hook is linked into the injector
      cdylib; see THIRD_PARTY_NOTICES.md).

## Docs

- [ ] PLUGIN-SDK MainContext/RendererContext — document which APIs are implemented vs future
      (the SDK types describe the target contract; the runtime implements a subset).

## Real-target validation (Aug 2026)

- [x] **Obsidian** (Electron 43.3.0) — injection + QuickJS sandbox + main plugin (`setOpacity`)
      + renderer plugin (`script.setDocumentTitle`) all work. (UI renders shell-only via a custom
      `app://` protocol — application-profile concern.)
- [ ] **OpenChamber** (Electron 43.3.0) — original app fails to start: the modded asar
      `package.json` lacks a `version`, so `app.getVersion()` falls back to the exe's 4-part
      `1.22.0.0`, which electron-updater rejects. Mitigation: copy the original asar's
      `version`/`name` into the modded asar (`make_package_json` in vendored electron-hook).
- [ ] **ChatGPT/Codex** — MSIX + a custom "owl" Electron fork; GUI does not start under raw-exe
      Detours launch (needs AUMID). Application-profile concern.

# ADR 0004 — Merged asar (Path I): the minimal stub hijacks app module resolution

Status: **Accepted — fix implemented; pending real-app confirmation** (2026-09-02)

Supersedes-correction for: `docs/adr/0001-injection-backend.md` (custom-protocol apps "need application
profiles"), `docs/adr/0003-compat-adapters.md` (Obsidian as the first adapter target).

## Context

The injected Obsidian 43.3.0 window loaded only the shell (`.workspace` never appeared). Gate 0 probes
(runtime adapter, `crates/runtime/js/src/adapters/obsidian.js`) established, with hard evidence:
- `app.getAppPath()` returned `...\resources\app.asar` with **only** `index.js`,`package.json`
  (`hasMainjs=false`) — this is the modded/stub asar, not the real app.
- The renderer emitted `Cannot find module '@electron/remote'` (require stack `electron/js2c/renderer_init`)
  and an uncaught `getCurrentWindow` TypeError.
- `app://` was registered (`isProtocolHandled('app')=true`), the top frame was the real
  `app://obsidian.md/index.html`, only ONE webContents existed (no hidden webview/window), and
  `.workspace` never mounted in 20s.
- The main process worked (Obsidian loaded, checked for updates) — only runtime **module-resolution**
  reads were broken.

## Root cause (confirmed)

`vendor/electron-hook` builds a minimal modded asar that contains only `index.js` + `package.json`
(`vendor/electron-hook/src/asar.rs:183-203`). `redirect_asar_path` is a substring match
(`vendor/electron-hook/src/paths.rs:52-75`): any read of `[app-folder]\resources\app.asar` is
redirected to that stub. The main process entry load works because the bootstrap reaches the real
archive through the `_app.asar` indirection. But every runtime read of `app.getAppPath()` (what the
renderer uses to resolve bare module specifiers like `@electron/remote`) returns the **stub**, whose
`node_modules` is empty → module resolution fails → the target SPA never mounts.

This is a generic injection-layer flaw, not an Obsidian-specific one: **any** app whose renderer
resolves runtime deps from the app path (or whose main reads `app.getAppPath()` content) is affected.
The test-app is unaffected only because its renderer is `sandbox:true / contextIsolation:true /
nodeIntegration:false` and never resolves from the app path.

## Decision

Build the modded asar as a **merged** asar — the entire real `resources\app.asar` content plus the
overridden `index.js` (the bootstrap entry template) and a patched `package.json` (`main` → `index.js`,
preserving `name`/`productName`/`version`) — so `app.getAppPath()` and renderer module resolution
serve the real files.

- **Where:** `crates/injector/src/asar_merge.rs` (new) + `crates/injector/src/bin/launcher.rs` wiring.
  Zero edits to the vendored LGPL `electron-hook`; it reuses the `asar` crate (v0.3.0, MIT/Apache-2.0)
  that electron-hook already depends on.
- **Runtime-only:** the merged asar is written only to `electron_hook::paths::asar_cache_path("tronhawk")`
  (our cache dir); target files are never modified.
- **Invariants preserved:** the `_app.asar` indirection, the `bootstrap.js` original-app load, and the
  entry template are unchanged.
- **Fallback / lever:** not finding a real `resources\app.asar`, a merge error, or
  `TRONHAWK_MINIMAL_ASAR=1` all fall back to the previous minimal stub (behavior unchanged for
  unpacked apps like VS Code). This is a permanent A/B diagnostic lever.
- **Universal, not per-app:** merge by default for every target with a real `resources\app.asar`; no
  per-app opt-in (which would leak app semantics into the app-agnostic launcher).

## Consequences / follow-ups

- **Path I requires the merged stub; Path C (`protocol.handle` wrap) is explicitly NOT the fix** — the
  content is broken before delivery, so wrapping the protocol would wrap stub bytes/ENOENTs.
- Accepted costs: one extra disk copy of the real asar in our cache; per-launch rebuild (sha256+copy,
  sub-second for small asars, maybe 1-3s for 100MB-class). Hash-keyed caching is a future optimization.
- The `executable` flag of copied asar entries is not readable from the source `AsarFile`, so entries
  are written non-executable. Benign on Windows; POSIX porting TODO.
- `.asar.unpacked` paths remain broken by the substring rule (noted; gate a follow-up vendored guard on
  evidence).
- Once the workspace mounts under the merged asar, the adapter work returns to **Path A**: add a
  `renderer.gate` seam (replace the fixed `did-finish-load` trigger) and flip `obsidian.js` from
  observe-only to `ready()`-on-`.workspace`, then add a custom-protocol `apptest://` fixture to
  `apps/test-app` for CI.
- Docs: `docs/AGENTS.md` (no Injector ownership change: injector = enter + comms; this stays injector-
  layer), `docs/SPEC.md` §8 (custom-protocol apps note), `docs/BACKLOG.md` (real-target item) updated.

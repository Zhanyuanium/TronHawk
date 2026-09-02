# ADR 0003 — Compat adapters (application compatibility slice)

Status: **Accepted** (Phase A landed 2026-09-02)

## Context

Real-target compatibility (SPEC §18 / docs/BACKLOG.md) is fundamentally per-application:
Obsidian serves its whole React UI through a custom `app://obsidian.md` scheme, so the generic
renderer injection (`webContents.insertCSS` / `executeJavaScript` on `did-finish-load`) reaches
only the shell, not the full workspace. Different apps need different compatibility shims.

We want these shims to be **decoupled** from the rest of TronHawk: TronHawk core ships the
generic interface; each app's compatibility logic lives behind it. But they must never become
a second path for arbitrary untrusted code.

## Decision

### 1. Adapters are trusted runtime substrate, not sandboxed plugins

- An **adapter** is app-compatibility logic that runs in the target's **main process** with full
  Node/Electron access and must run **before the original app loads** (to hook `protocol.handle`,
  intercept the entry document, etc.).
- It therefore **cannot** be sandboxed in the QuickJS plugin VM: the plugin VM loads asynchronously
  (`index.js` waits on `getQuickJS().then(...)`) and late — after plan polling — so it is
  technically incapable of the pre-app-ready work an adapter needs. Sandboxing adapters would make
  the feature impossible.
- An adapter's privilege is **exactly the injection's own privilege** (the bootstrap already runs
  with full Electron access). It adds no new trust tier; it is runtime substrate, same trust domain
  as `runtime.js` itself.

Therefore the security-relevant boundary is **trusted substrate vs untrusted extension**, not
"adapter vs plugin". Plugins remain untrusted QuickJS, permission-gated as before.

### 2. Structurally close the escape hatch

Adapters are **bundled statically into `runtime.js`** (`crates/runtime/js/src`), versioned,
reviewed, and released with the core artifact. They must **never** be:
- loadable/discoverable from disk in the target,
- installable via the `.thx` plugin channel (SPEC §9),
- surfaced in the plugin permission UI (SPEC §10).

Third-party *distributable* adapters are a future signed-distribution problem (like driver
signing), covered by a separate ADR — not implied by this design.

### 3. Minimal generic interface (no premature generalization)

Phase A exposes only:

```js
// crates/runtime/js/src/adapters.js
{
  id: "obsidian",           // stable string; logged with every adapter event
  apiVersion: 1,            // internal contract version
  matches(appInfo),         // required; SYNC; pure; a throw is treated as no-match
  onBootstrap(ctx),         // optional; SYNC; runs before the original app loads
}

// Host constructs AppInfo and passes it via ctx:
appInfo = {
  name,            // app.getName()
  appPath,         // app.getAppPath()
  packageJsonName, // best-effort <appPath>/package.json .name (undefined if unreadable)
  exeBasename,     // path.basename(process.execPath)
  electronVersion, // process.versions.electron
}
ctx = { app, appInfo, protocol, log }
```

Deliberately **excluded** from Phase A (avoid pre-building generality): a `renderer.gate` seam
(lands only when a real consumer exists, Phase B), `onWindowCreated`, a plugin-facing adapter
"capability" (`ctx.app`), a JSON/TS adapter manifest, launcher env selection, and threading
Core's `application_id` into the launch env (Core's id is a non-semantic storage key).

### 4. Loader lives in the Runtime layer; Injector/Core untouched

The adapter loader is `crates/runtime/js/src/adapters.js` (registry + `select()` + AppInfo
construction + fail-open). `index.js` `start()` performs selection + `onBootstrap`
**synchronously** before it returns. This is the critical ordering invariant:

```
bootstrap.js: runtime.start(app, {...})  // adapter selected + onBootstrap runs HERE
bootstrap.js: require(originalAsar)      // original app loads AFTER, so adapters hook first
```

`bootstrap.js` stays transport-only (AGENTS.md ownership). The Injector, Core, launcher, IPC, and
env plumbing are unchanged. Fail-open: an adapter that throws is logged and the target continues.

## Consequences / follow-ups

- Adapters run in the main process with full access; they are curated core-owned code.
- "**Application profiles**" (per-app plugin selection UX, app recognition, Manager UI) remains
  **deferred** and is a distinct, larger concern. "**Compat adapters**" is its narrow, trusted
  slice and is what's being built. Docs/AGENTS.md and docs/SPEC.md §8/§18 are updated to keep the
  distinction truthful and to keep the deferred wording accurate.
- Obsidian adapter (Phase B) is evidence-gated: instrument frames first (is the workspace in a
  sub-frame, late in the top frame, or never?), and only reach for `protocol.handle` wrapping as a
  last resort — wrap-don't-takeover (forward all requests to Obsidian's handler, splice only the
  entry HTML with an inline bootloader). Never consume `registerSchemesAsPrivileged` (once-only).

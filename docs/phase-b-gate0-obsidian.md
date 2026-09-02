# Phase B — Obsidian Gate 0 observation matrix

Status: **in progress** (ADR 0003 / Phase B step 1)

The Obsidian compat adapter (`crates/runtime/js/src/adapters/obsidian.js`) currently performs
**passive observation only** ("Gate 0"). We must run it against a real Obsidian install and record
the observables below before choosing an injection strategy. Do **not** build a `protocol.handle`
interception or a retimed injection seam until this matrix is filled in.

## Why

Obsidian serves its whole React UI through a custom `app://obsidian.md` scheme. The runtime's current
`did-finish-load` injection reaches only the shell. We do not yet know whether the real workspace
(the `.workspace` DOM node) appears (a) **late in the top frame**, (b) **in a subframe / second
webContents**, or (c) **never** under injection.

`insertCSS` is document-level and time-independent, so an "unstyled UI" symptom is NOT explained by
timing alone; the workspace must live in a different document/frame, or never mount. Gate 0 resolves
this empirically.

## How to run

1. Build the injector + runtime (root cargo + `bun run build` in `crates/runtime/js`), then launch a
   real Obsidian 43.3.0 (standard Electron) through the TronHawk launcher wrapper so the adapter
   matches (`app.getName()`/`packageJsonName` = "obsidian", or exe = `Obsidian.exe`).
2. Allow the app to sit for ~30s. The adapter logs `obsidian:gate0 ...` lines to the Runtime stream.
3. Capture the Runtime log stream.

## Log lines to collect

- `obsidian:gate0 identity name=... appPath=... packageJsonName=... exeBasename=... electronVersion=...`
- `obsidian:gate0 protocol[initial|recheck] isProtocolHandled(app)=...` (initial at bootstrap, recheck at ~4s/16s)
- `obsidian:gate0 observe url=<frameUrl> isTop=...`
- `obsidian:gate0 navigate url=<frameUrl> isTop=...`
- `obsidian:gate0 frame=<frameUrl> isTop=... workspaceAtMs=<ms | never | unknown>`
- `obsidian:gate0 summary topFrame=... workspaceFrame=... isTop=... workspaceAtMs=... foundFrames=...`

## Decision table

| Observed | Interpretation | Recommended path |
|---|---|---|
| `.workspace` appears in the **top frame, late** (large `workspaceAtMs`) | Timing-only; the workspace is in the same document, mounted asynchronously | **Path A** — add a `renderer.gate` seam that polls for `.workspace` before injecting |
| `.workspace` appears in a **subframe** or a **second window/webContents** | The real UI is a different document; the runtime's top-frame injection can't reach it | **Path B** — generalize frame/window tracking and deliver CSS/JS per-frame |
| `.workspace` appears in **no frame** but Obsidian is otherwise usable | The workspace document is served behind `app://` in a way our environment breaks | **Path C** — wrap `protocol.handle` to splice the entry HTML (last resort) |
| `isProtocolHandled(app)` recheck stays `false` | Obsidian never registered `app://` (unexpected) | Investigate; likely signals an environment/launch difference |

Also record empirically: does `insertCSS` style any subframe? (This tells us whether Path B is needed for
CSS or only for JS.)

## Path A / B / C success criteria

- **Path A:** an injected test style (e.g. a visible outline on `.workspace`) appears and **CSS hot
  reload** (plan-revision bump → re-apply) visibly applies/removes.
- **Path B:** same as Path A, but on the workspace frame; frame recreation must re-inject.
- **Path C:** a bootloader log line in the runtime log; the vault opens; ≥2 notes render; the Settings
  and community-plugins pages work; CSS applies; the app stays functional for a full session. The
  regression checklist below is the acceptance gate.

## Path C regression checklist (only if observable path C)

- All `app://` paths continue to resolve (vault reads, plugin assets, service-worker/cache behavior).
- HEAD/range/streaming passthrough on non-HTML responses.
- Inline bootloader `<script>` is allowed by CSP (privileged-scheme pages typically allow it).
- Never consume `registerSchemesAsPrivileged` (once-only) — use an inline `<script>` in the spliced HTML.

## Report back

Record the observation rows plus the chosen path in this file (or in `docs/adr/0003-compat-adapters.md`
once the path is decided). Gate 0 is a manual, one-time matrix; the real Obsidian run is closed-source
and cannot be automated in CI. The CI-able parts (matcher, probe wiring) already ship and are covered
by `crates/runtime/js/src/adapters/obsidian.test.js`.

## Gate 0 run #1 result (already observed)

```
tronhawk] obsidian:gate0 protocol[recheck] isProtocolHandled(app)=true   (x2, ~4s & ~16s)
[tronhawk] obsidian:gate0 frame=app://obsidian.md/index.html isTop=true workspaceAtMs=never
[tronhawk] obsidian:gate0 summary topFrame=unknown workspaceFrame=none workspaceAtMs=never
```

Analysis: `app://` IS registered, the top frame is `app://obsidian.md/index.html`, but `.workspace`
never appears anywhere in 20s and no subframe reports it. Research (ADR 0003 companion) established
that `.workspace` is Obsidian's real UI root and the full workspace is in the SAME top-level
document — so this is a **true negative**: the workspace never mounted in that document.

**Ranked hypotheses (from analysis):**
1. **(c) stub-asar content hijack (~70%)** — the config/modded asar only contains `index.js` +
   `package.json`; `redirect_asar_path` is a substring match, so Obsidian's runtime self-reads of
   `app.getAppPath()` (`...resources\app.asar\...`) are redirected to the stub → SPA assets 404 →
   `.workspace` never mounts. This points to a new **Path I** (fix the injection layer: build the
   stub as a **merged** asar — original app files + overridden entrypoint).
2. (a) wrong selector / timing (~25%) — refuted-ish by the `.workspace`-is-correct research, but the
   probe was too weak to fully rule out (single boolean only).
3. (b) real UI in an unenumerated webContents/frame (~5%) — the probe walks the frame tree but
   filters `getType() === "window"`.

**Do NOT jump to Path C.** Wrapping `protocol.handle` around content that is already broken
(stub bytes/ENOENT) would add the largest, riskiest mechanism with nothing to fix. Path C must be
gated on positive evidence that content loads correctly.

## Enhanced decision gate (Gate 0 run #2 — decide with the A-D probes)

| Observable (run #2) | Diagnosis | Build |
|---|---|---|
| `readdir(app.getAppPath())` = stub-only (`index.js`,`package.json`) **or** console shows `app://` asset 404s **or** `head` snapshot contains our `require(process.env.MODLOADER...` stub text | **(c) stub-asar content hijack** | **Path I** — fix the injection layer: build a merged asar in the launcher/vendored `asar.rs` so Obsidian's runtime self-reads get real content (runtime-only, stub lives in our cache dir). New ADR. |
| Real Obsidian HTML, clean console, large `bodyChildCount` in the **top frame**, `.workspace` appears **late** | (a) timing, selector confirmed | **Path A** — `gate()` polling on the confirmed selector |
| `.workspace`/`sel.*` found only in a **child frame / second webContents** | (b) targeting gap | **Path B** — per-frame/webContents targeting |
| Real HTML, assets load cleanly, workspace mounts in an enumerable document, but injection is rejected/overwritten post-hoc | true reachability problem | **Path C** — wrap `protocol.handle` + inline bootloader (only here; not supported by current evidence) |

## Gate 0 run #2 result — Path I CONFIRMED

```
[indentity] name=Obsidian appPath=C:\Program Files\Obsidian\resources\app.asar exeBasename=Obsidian.exe electronVersion=43.3.0
[main] Loaded main app package C:\Program Files\Obsidian\resources\obsidian.asar
[protocol recheck] isProtocolHandled(app)=true
[webContents recheck] id=1 type=window url=app://obsidian.md/index.html   (only ONE window)
[selfread recheck] appPath=C:\Program Files\Obsidian\resources\app.asar entries=index.js,package.json hasMainjs=false
[console] app://obsidian.md/app.js:1 Error: Cannot find module '@electron/remote' (reque stack: electron/js2c/renderer_init)
[console] app://obsidian.md/app.js:1 TypeError: Cannot read properties of undefined (reading 'getCurrentWindow')
[dom] app://obsidian.md/index.html readyState=complete bodyChildCount=14 htmlLen=1488 head=<real Obsidian HTML lang=zh CSP> sel.workspace=false workspaceLeaf=false app=false appContainer=false
[summary] workspaceAtMs=never workspaceFrame=none
```

**Diagnosis (confirmed):** `app.getAppPath()` returns the **stub** asar (only `index.js`,`package.json`, no `main.js`). Obsidian's
renderer resolves runtime deps relative to the app path, so `@electron/remote` is missing → `getCurrentWindow` undefined →
the workspace SPA never mounts (`.workspace` never appears). The shell (`app://obsidian.md/index.html`) is real Obsidian HTML,
but the workspace element is absent. Only one webContents → no hidden window/webview (Path B ruled out). Main process works
(Obsidian loads, checks updates) — only the runtime module-resolution reads are broken.

**Verdict: this is a PATH I (injection-layer stub-asar content hijack), not a per-app adapter concern.** The modded asar
(`resources\app.asar`) must be a **merged** asar (original app content + overridden entrypoint) so `app.getAppPath()` and
renderer module resolution serve the real files. This likely affects any app that resolves modules from `app.getAppPath()`
at runtime (custom-protocol apps most obviously). Fix in the injection layer (launcher / vendored `asar.rs`).

**Path C (protocol.handle) is explicitly NOT the fix** — the content itself is broken before delivery; wrapping the protocol
would wrap ENOENT/stub bytes.

## Gate 0 run #2 log lines to capture

- `obsidian:gate0 webContents id=... type=... url=...` (A — every webContents, in case the UI is a popout/webview/DevTools)
- `obsidian:gate0 selfread appPath=... entries=... hasMainjs=...` (D — decisive for Path I)
- `obsidian:gate0 console <sourceId>:<line> <message>` and `... did-fail-load ...` / `... render-process-gone ...` (C — asset 404s/loading errors)
- `obsidian:gate0 frame=... {readyState,bodyChildCount,title,url,htmlLen,head,sel} workspaceAtMs=...` (B — rich DOM snapshot)

Record the chosen path here once run #2 is analysed.

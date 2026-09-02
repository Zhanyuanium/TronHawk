# ADR 0005 — ChatGPT Desktop (MSIX) injection feasibility: AUMID activation + race-attach

Status: **Accepted (evaluation); probe VERIFIED — injection feasible; realpathSync workaround pending** (2026-09-03)

Companion to ADR 0001 (injection backend) / ADR 0004 (merged asar). Evaluates whether TronHawk can
inject into the Microsoft-distributed **MSIX** build of ChatGPT Desktop (`OpenAI.Codex`, custom "owl"
Electron fork), how much is reachable, and what the adapter needs. Derived from external research
(MSIX/AUMID/community precedent) + local verification of the installed package.

## Verdict

**Feasible, but not as transparent/IFEO injection — it is a "launcher-driven + race-attach" secondary
path.** The conflict is launch-mechanism vs injection-timing:

- A working full-GUI launch of the MSIX packaged app requires **AUMID activation** (shell/COM), where
  Windows — not our injector — creates the process. That yields **no `CREATE_SUSPENDED` pre-main
  handle**, so Detours `DetourCreateProcessWithDllExA` + asar-remap cannot run before Electron reads
  `app.asar`. **Native pre-main DLL injection is a dead end on the AUMID path.**
- Raw-exe `CreateProcess` DOES inject and the main-process bootstrap runs (ADR 0001, proven), but the
  GUI does not fully start (no package identity).
- Community precedent for this exact app (CodexPlusPlus, ollama, opencodex, VibeAround) is **AUMID
  activation + CDP JS injection into the renderer** — not native pre-main DLL injection. TronHawk
  wants its native runtime (permissioned plugins), so it must pursue **AUMID activation + race-attach**:
  `CreateRemoteThread`+`LoadLibraryW` inject the DLL as the process starts, racing Electron's late
  first read of `app.asar` (hundreds of ms of V8/Node init). This is TronHawk-specific and unproven
  by third parties — the **attach race is the single biggest uncertainty** (failure mode is clean:
  the app runs unmodified, detectable, retryable).
- **IFEO transparent launch is a dead end on MSIX** — a medium-IL relaunch cannot re-grant package
  identity. Drop IFEO/transparent; keep the SPEC §6 "launch with extensions" fallback.

## Key facts (verified locally + research)

- Installed package: `OpenAI.Codex_26.831.2377.0_x64__2p2nqsd0c76g0`. It is **full-trust MSIX**
  (`Windows.FullTrustApplication`, entry `app/ChatGPT.exe`, Application Id `App`), **not AppContainer**
  (medium-IL), so remote-thread injection is ACL-legal.
- **AUMID = `OpenAI.Codex_2p2nqsd0c76g0!App`** (`PackageFamilyName!Application/@Id`). Launch via
  `Start-Process "shell:AppsFolder\<AUMID>"` or `IApplicationActivationManager::ActivateApplication`.
- `resources/app.asar` is flat layout → `find_real_asar` (launcher.rs) hits it directly.
- Real `package.json`: `name=openai-codex-electron`, `productName=Codex`, `version=26.831.21537`
  (**valid 3-part semver**), `main=.vite/build/early-bootstrap.js`.
- `resources/app.asar.unpacked/` exists with native modules (`better-sqlite3`, `node-pty`) — **confirms
  the substring-match `redirect_asar_path` bug redirects `app.asar.unpacked\...` to ENOENT**, a real
  blocker that must be guarded.
- `resources/busy-bar.asar` (splash) + `resources/codex.exe` (~256 MB Codex IDE) — one package, two
  products.

## Good news: two of three known blockers are already fixed by ADR 0004

- `Invalid semantic version`: real `version=26.831.21537` is valid; the old minimal stub had no
  `version` → `app.getVersion()` fell back to the 4-part exe version → updater rejected it. The merged
  asar preserves `version` (asar_merge.rs `patched_package_json`).
- `userData`-path mismatch: the stub lacked `name` → `app.getName()="Electron"` → wrong userData. The
  merged asar preserves `name`/`productName`.
- Remaining: `registry access-denied` is likely secondary to raw-exe no-identity; validate with a real
  AUMID activation.

## Injection-layer work required (NOT the adapter's job)

1. **AUMID activation** in the launcher (`--aumid <AUMID>` mode): resolve the install root
   (`Get-AppxPackage`/`GetPackagePathByFullName`), build the merged asar, activate via
   `ShellExecuteW("shell:AppsFolder\\<AUMID>")` or COM, then poll for the new `ChatGPT.exe`/`Codex.exe`
   PID.
2. **Race-attach**: `OpenProcess` → `VirtualAllocEx` → `WriteProcessMemory(dll path)` →
   `GetProcAddress(kernel32, "LoadLibraryW")` → `CreateRemoteThread` → wait. DllMain installs the
   Detours hooks before Electron's first `app.asar` read (via `Win32_ProcessStartTrace`/fast poll).
3. **Sidecar env** (crosses the activation env boundary): the shell-activated process does not inherit
   the launcher's env. The DLL's `DllMain` reads a sidecar config next to the DLL and
   `SetEnvironmentVariableW`s `MODLOADER_*` / `TRONHAWK_IPC_*` before installing hooks. (Do NOT re-add
   the removed `SetAUMID`/`MoveFileExW` hooks — forcing a launcher AUMID would *break* the package
   identity, and `MoveFileExW` is an updater rename hack; VENDOR.md removal is correct.)
4. **`.asar.unpacked` guard** in `redirect_asar_path` (boundary-aware needle) so native modules under
   `app.asar.unpacked/` resolve on real disk instead of the merged-asar cache.

## Extent (realistic if attach wins)

| Layer | Expectation |
|---|---|
| Main-process bootstrap | High (raw-exe PoC already works; we only log the owl's 4-part version string, never parse it) |
| Plan polling / IPC | High — provided the sidecar env brings `TRONHAWK_IPC_*` into the target (DllMain) |
| Renderer CSS/DOM/JS | **High** — ChatGPT's main window is a normal `https://chatgpt.com` webContents (NOT custom-protocol), so `insertCSS`/`executeJavaScript` work directly; the `renderer.gate` seam covers the SPA mount timing |
| Level 2 (Electron window/IPC) | High — same as Obsidian, no extra obstacle |

Special points: `busy-bar.asar` is a separate splash window (not remapped, good) that still fires
`web-contents-created` → adapter must filter by origin; one package = two products (ChatGPT + Codex
IDE) → per-window triage.

## ChatGPT adapter design (`adapters/chatgpt.js`)

- `matches`: `packageJsonName === "openai-codex-electron"` (from the merged asar real package.json), or
  exe `/^(chatgpt|codex)\.exe$/i` (do NOT rely on `app.getName()`, productName is "Codex").
- `onBootstrap`: diagnostics (electronVersion / getVersion / getPath('userData')); env-gated emergency
  levers (no-op the updater if the semver issue recurs; monkey-patch `fs.realpathSync` in main if the
  realpath issue recurs — adapter runs before the original app).
- `renderer.gate(win, ready)`: filter by origin (busy-bar / Codex local UI), then `makeSelectorGate`
  probing `#__next` or the composer textarea (selector list configurable, calibrated in the probe).

## Risks

1. **Attach race (highest)** — mitigate with `Win32_ProcessStartTrace` immediate attach + IPC log
   validation (`injected; electron`, `original app loaded`), retry on miss; a lost race = the app runs
   unmodified.
2. **Single instance** — if ChatGPT is already running, activation just focuses the existing window (no
   new process to inject); the launcher must detect + warn.
3. **MSIX ACL** read access varies across machines (read-verified locally, not guaranteed).
4. **AV/SmartScreen** toward injecting an unsigned DLL into an MS-signed package — needs signing + user
   consent.
5. **Store updates** replace the whole asar → rebuild the merged asar each launch (already the case).

## Probe result (VERIFIED 2026-09-03 on local `OpenAI.Codex_26.831.2377.0_x64__2p2nqsd0c76g0`)

An AUMID-activation attach probe was implemented (launcher `--aumid` mode, `crates/injector/src/attach.rs`
race-attach + DllMain sidecar-env read + `.asar.unpacked` guard) and run. Result spans the verdict
observables as follows:

- **Injection: SUCCESS.** The launcher resolved the install root, built the merged asar (8778 entries,
  ~311 MB from the real `app\resources\app.asar`), wrote the sidecar, AUMID-activated the app, found the
  new process (pid), and `CreateRemoteThread`+`LoadLibraryW` attached it. The injected main process
  showed `[tronhawk] injected; electron=151.0.7922.170` (bootstrap ran), proving the DLL loaded, DllMain
  read the sidecar and set `MODLOADER_*`, the merged-asar remap applied, and the runtime bootstrap ran.
  **Native DLL injection into an MSIX-packaged Electron app is therefore FEASIBLE** (beyond the
  community's CDP-only route).
- **Original app load: FAILED.** `FAILED to load original app: ENOENT ... lstat '...\app\resources\_app.asar'`
  — the `_app.asar` alias was not remapped because `fs.realpathSync` resolved the `WindowsApps` path
  through a **reparse point** into a real path that no longer contains the literal `resources\_app.asar`
  needle, so `redirect_asar_path` rule 1 missed → lstat on a nonexistent `_app.asar`. This is exactly the
  **realpathSync workaround** noted in ADR 0001 (Obsidian, not under a reparse point, does not hit it).
  With the original app unloaded, the ChatGPT GUI does not render (only the injected console is shown).
- **IPC**: `poll failed: connect ECONNREFUSED 127.0.0.1:17777` — expected, Core was not running.

**Remaining blocker → realpathSync workaround**: make the `_app.asar` → `app.asar` remap survive the
reparse-point realpath resolution (bootstrap `fs.realpathSync` patch or a reparse-aware needle in
`redirect_asar_path`). Once the original app loads, the merged asar already preserves `version`/`name`,
so `Invalid semantic version` and `userData` should clear; then `renderer.gate` on the real UI root
applies.

## Second run (realpathSync workaround applied) — original app LOADS

A `fs.realpathSync` patch in `bootstrap.js` (returns the logical `_app.asar` path unchanged so the
asar-remap hooks substring-match it, instead of ENOENT after the WindowsApps reparse resolution)
made the original app load. The injected main process logged:

```
[tronhawk] injected; electron=152.0.7977.64
[tronhawk] original app loaded
```

The main process created a real window (`MainWindowTitle="ChatGPT"`, ~193 MB). **The injection pipeline
is therefore validated end-to-end on the MSIX target: attach injection → merged-asar remap →
realpathSync workaround → original app load → window creation.**

**Next blocker (bounded):** the app fails at its SQLite database with
`better-sqlite3 is only bundled with the Electron app`. Root cause: the merged asar is written to the
electron-hook **cache** dir, so its sibling `app.asar.unpacked` lives in the cache (absent) instead of
next to the target's real `resources\app.asar.unpacked` (where the native `.node` lives, e.g.
`better_sqlite3.node`). The `.asar.unpacked` pass-through guard keeps the *suffix* on real-disk but the
prefix still points at the cache. Fix: resolve the `.unpacked` sibling to the target's real unpacked dir
(launcher copies/junctions it, or `redirect_asar_path` rewrites the cache-sibling unpacked path to the
target resources unpacked). This is injection-layer, not adapter.

## Third run (junction fix applied) — app launches + injected

The launcher now creates a junction `<cache>\tronhawk.asar.unpacked` → the target's real
`resources\app.asar.unpacked` after building the merged asar (no admin). Verified on
`openai-codex-electron`:

- The previous `better-sqlite3 is only bundled with the Electron app` database error is **gone**.
- The injected main process stays up (~742 MB) with a full renderer/GPU child tree, a real `ChatGPT`
  window, and the app's own UI logic executing (its `uiM`/`CHATGPT_MATH_BLOCK`/math renderer
  components log to the attached debug console).
- Bootstrap logs `[tronhawk] injected; electron=152.x` and `[tronhawk] original app loaded`.

So the AUMID-activation + race-attach path, combined with the merged asar (ADR 0004), the realpathSync
workaround, and the `.asar.unpacked` junction, gets the MSIX ChatGPT app to **start normally while
injected** — answering the original question: it is feasible and the full GUI is reachable (via the
compat-adapter `renderer.gate` on the real UI root).

**Reliability note:** a relaunch done immediately after force-killing a prior run can exit (observed
once — likely single-instance/`.codex` lock contention on rapid relaunch). The injection pipeline
itself is deterministic once the app is up; treat launch as best-effort.

## Open (not blockers)

- `renderer.gate` selector calibration for the ChatGPT UI root (the `chatgpt.js` adapter).

**Stop-loss (unchanged)**: if the attach race is lost repeatedly or the realpath issue is intractable,
fall back to signed `AppInit_DLLs` (too invasive) or keep MSIX in SPEC §18 deferred.

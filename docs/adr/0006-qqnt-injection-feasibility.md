# ADR 0006 — QQNT (new QQ, 9.9.x Windows) injection feasibility

Status: **Accepted (evaluation)** — verdict **NOT FEASIBLE under TronHawk invariants; QQNT is a Level 0 (unsupported) target** (2026-09-03)

Companion to ADR 0001 (injection backend) / ADR 0004 (merged asar) / ADR 0005 (ChatGPT MSIX).
Evaluates whether TronHawk can inject its runtime into the Tencent **QQNT** (new QQ) Windows
client, how much is reachable, and what blocks it. Derived from external research (QQNT architecture,
LiteLoaderQQNT precedent, Tencent anti-tamper) + local read-only recon of the installed package.

## Verdict

**Not feasible under TronHawk's binding invariants.** QQNT is a **hardened Electron target** and
belongs in **Level 0 (unsupported)**: runtime-only / no-disk-mutation / no-native-hook TronHawk cannot
load its runtime into it because the target is engineered to detect and reject exactly the operations a
merged-asar runtime injection performs.

Two facts combine into this verdict:

1. **QQNT is Electron**, so the injection *transport* (Detours pre-main DLL inject + in-memory ASAR
   remap) is architecturally applicable — `QQ.exe` is the browser-process host and
   `resources\app\application.asar` is a remappable asar with a fixed `/app_launcher/index.js` entry.
2. **QQNT is integrity-hardened and anti-tamper-active**, so the *payload* that the transport would
   expose is caught before/while the GUI loads:
   - a **native SHA256 signature** of the asar+payload (and of `QQNT.dll`) that rejects byte-inconsistent
     content ("文件损坏" / refuses to start the GUI) — a merged asar is byte-different, so the remap is
     detected;
   - a **bytecode shell** (`isByteCodeShell: true`) — the main-process JS is V8 bytecode, not plain
     source, so there is no usable JS to rewrite in the asar;
   - a **Tencent anti-tamper runtime** (`TPDataTransport` / `QBar` / `TSSafeEdit` / `Timwp`) plus a
     **packed runtime binary** (`QQNT.dll`: `CPADinfo` / `LZMADEC`, hash-obfuscated imports, `.prot`
     sections) that actively checks for foreign modules/thread injection and Hook signatures.

The one community-proven runtime-only route (NapCat-Windows-Boot) is **native in-process patching of
`QQNT.dll`'s signature-verify function** (`hookVeify`/`hookVeifyNew`) plus IAT-hook of
`CreateFileW`/`GetProcAddress` to hide itself. That is a **native hook — explicitly forbidden** by
TronHawk's architecture (`docs/AGENTS.md` "must NOT", SPEC §17 mitigation, SECURITY.md Level 0). It is
the *opposite* of TronHawk's electron-hook (clean asar remap + pure-JS runtime).

## Local recon (verified, read-only) — installed `versions\9.9.21-39038`

| Fact | Evidence |
|---|---|
| Install root | `C:\Program Files\Tencent\QQNT\`; launchers `QQ.exe` (1.6MB), `QQEX.exe` (1.9MB) |
| Host is Electron | `LICENSE.electron.txt`, `chrome_*.qq.pak`, `icudtl.dat`, `ffmpeg.dll`, `libEGL.dll`, `snapshot_blob.bin`, `v8_context_snapshot.bin`, `locales\` |
| Main host binary | `QQ.exe`/`QQEX.exe` = x64, **PDB `electron.exe.pdb`** → they ARE the (renamed/slimmed) Electron main-process host, not plain launchers |
| Runtime is a mega-DLL | `versions\9.9.21-39038\QQNT.dll` (187MB) merges Electron/Chromium/Node; x64; packed (`.text` 158MB, `.gxfg`, `CPADinfo`, `LZMADEC`, `.prot`; **hash-obfuscated import/export tables**) |
| App payload path | `resources\app\application.asar` (15MB) — **not** standard `app.asar`; package located under per-version `versions\<ver>\` |
| Entry | `resources\app\package.json` → `"main": "./application.asar/app_launcher/index.js"`; `isPureShell:true`, `isByteCodeShell:true`, `eleArch:"x64"` |
| Bytecode shell | `app_launcher/index.js`, `launcher.js`, `adm-zip.js` are only **80 bytes** each and non-text first bytes → **V8 bytecode, no source** |
| Integrity manifests | `resources\app\application.json` (RSA-shaped blob) fingerprints `application.asar`, `wrapper.node`, `major.node`, `package.json`; `versions\...\version.json` fingerprints `QQNT.dll` |
| Native core | `wrapper.node` (84MB), `major.node` (79MB), `ipc.node`, `qqex.node`, `sharp`, `bsdiff` — the real QQ logic is native, the asar shell is thin |
| Anti-tamper components | `TPDataTransport.dll` (8.6MB), `TPDX11Renderer.dll`, `TPLuminance.dll`, `QBar.dll` (12.7MB), `QBarDet/Seg/SRV*.xnet`, `TSSafeEdit.dat`, `Timwp.exe`, `BugReport.dll` |
| Tencent familiarity | `avsdk\d3d-hook-x64/x86.dll` + `libMinHook-x64/x86.dll` → Tencent uses MinHook itself; anti-Hook detection is plausible |

## External research (LiteLoaderQQNT precedent + anti-tamper)

- **Electron, confirmed independently** by plugin loaders that use standard Electron APIs
  (LiteLoaderQQNT `require.cache["electron"]` + Proxy on `BrowserWindow`; NapCat
  `process.versions['electron']`, `utilityProcess.fork`).
- **LiteLoaderQQNT (MIT) two generations:**
  - Plain era (≲9.9.15): writes a `LiteLoader.js` next to the asar and rewrites `package.json`'s `main`
    to it; then `require`s the original `./application.asar/app_launcher/index.js`. **On-disk change.**
  - Hardened era (9.9.16+/9.9.21+, bytecode + integrity): requires a native `dbghelp.dll` side-load, or
    `QQNTFileVerifyPatch` which **patches the `QQNT.dll` SHA256-verify** (`call`→`mov eax,1`) to
    bypass the "文件损坏 / refuse to start" check.
- **Integrity is real and active.** `QQNT.dll` SHA256-verifies itself + the `resources\app` payload at
  startup; tampering `package.json`/asar → "文件损坏", GUI refuses to start. There is also a runtime
  recheck loop + `GetProcAddress` introspection (NapCat-Windows-Boot must hide its own imports).
- **Account-level risk control (service-side):** LiteLoaderQQNT's own README warns the QQ Security
  Center may treat the loader as an illegal plug-in and **blacklist the device / the account**. Even a
  local pass carries no safety guarantee.
- `TPDataTransport`/`QBar` mapped to Tencent anti-cheat by naming convention (TP data channel, QBar
  engine + `.xnet` rule data); `TSSafeEdit.dat` is a known SafeEdit anti-Hook blob in Tencent login
  payloads. Evidence: TPDataTransport/QBar `QBarDet` are strong-by-convention but not individually
  documented publicly.

## Where injection could apply — and why it stops

| Layer | Expectation |
|---|---|
| Transport (Detours pre-main inject into `QQ.exe`, in-memory asar remap) | **Plausible** — `QQ.exe` is the Electron host, entry pinned to `application.asar/app_launcher/index.js`. The different asar name/path is an injector-layer adaptation, not a fundamental blocker. |
| Bootstrap / plan-polling / IPC | Blocked in practice — needs the merged asar to be *read* as the real payload; the native signature verify sees the byte-different merged asar and rejects before the GUI mounts. |
| Renderer CSS/DOM/JS | Unreachable — the main process never finishes loading the GUI under a rejected payload; the renderer is a normal `webContents` (not custom-protocol), but it never opens. |
| Level 2 (Electron window/IPC) | Unreachable for the same reason. |

## Blocking factors (ranked by impact on the electron-hook model)

1. **Integrity self-verify (startup + runtime)** — Level 0 one-vote veto. In-memory asar remap makes the
   bytes actually read differ from the signed hash → tamper. The only known bypass is native in-process
   patching of the verify function, which TronHawk forbids.
2. **Bytecode shell (`isByteCodeShell`)** — main-process JS is non-plaintext; there is no JS source to
   rewrite in the asar, so the "pure-JS bootstrap in the merged asar" premise has no wedge. Requires a
   native loader to go around it.
3. **Runtime in `QQNT.dll` (packed), not a standard `electron.exe`** — the Detours hook targets and the
   Electron/Node symbol surface live behind a packed, hash-obfuscated boundary; the classic
   IAT/export-hook path may not be visible. Also per-version patching is needed.
4. **TP / QBar / SafeEdit + account risk control** — active anti-tamper modules in the process plus
   service-side device/account blacklisting. No safety/reliability guarantee; this is the same reason
   SECURITY.md lists anti-cheat/banking apps as Level 0.
5. (Minor, injector-layer only) `application.asar` path + per-version directory layout — remappable,
   not a blocker.

## Open / uncertainties (honest boundaries)

- The installed 9.9.21 directory is **incomplete / pending update** (`versions\` holds
  `9.9.32-51246.zip`, `9.9.33-52230.zip.zip`; no standalone `electron.exe`), so the real process-chain
  (does a child electron-ish process spawn? exact host name) and the symbol visibility could **not be
  empirically verified on this machine without launching QQ** — intentionally not done (triggering
  protection). The recon conclusions rest on PE/header/byte inspection + external source.
- Whether the signature verify is strictly native (`QQNT.dll`) vs partly JS-layer is inferred from
  `QQNTFileVerifyPatch`'s native patch and the bytecode shell; not re-confirmed locally per-file.
- `TPDataTransport`/`QBarDet` per-DLL responsibilities are convention-based (strong signal), not
  individually documented.
- Per-version differences (9.9.21 vs 9.9.32/9.9.33) may change the bytecode/verify shape; the verdict
  direction is stable (Tencent keeps hardening this line), but specific offsets/nuped facts would need
  a clean, current, runnable version.

## Interop note — third-party-loader piggyback (Mode B), documented for future exploration only

The Level 0 verdict above concerns TronHawk **injecting itself into QQNT via its own Injector**. A
different question is whether TronHawk could reach QQNT by **interoperating with a third-party loader
the user already installed** (e.g. NapCatQQ / LiteLoaderQQNT). Two modes, kept here so a future
exploration can pick the question up without re-doing the research:

**Mode A — protocol client (clean but off-purpose).** A loaded NapCatQQ exposes an OneBot
HTTP/WebSocket bot API. TronHawk could connect as an ordinary external client: no injection, no
invariant violation. But that surface is **bot/messaging only** (message/session/group) — it has **no
CSS injection, no renderer DOM, no BrowserWindow/Electron/IPC control**, i.e. it cannot deliver
TronHawk's actual Level 1/Level 2 value. It reduces TronHawk to a bot driver, not an extension platform.

**Mode B — run TronHawk's runtime as a plugin *inside* a third-party loader (piggyback).** Mechanically
feasible: a loader's job is to run plugins in the QQ main process (NapCat uses `utilityProcess.fork`
inside QQ; LiteLoader rewrites `package.json`'s `main` or ships a native boot DLL). TronHawk's
`runtime.js` could register as such a plugin and execute in the target's main process. Why it is still
**out of scope under current TronHawk invariants** (and thus NOT a supported config, only a note):
- **Prerequisite voids the invariant.** For any loader to be in QQ it already had to mutate files on
  disk (LiteLoader plain) or native-patch `QQNT.dll` + IAT-hook to hide itself (NapCat-Windows-Boot).
  TronHawk riding on it can no longer claim "runtime-only, no disk mutation, no native hooks" — the
  target was changed by a third party, and the extension sits on a native patch.
- **The host is unbounded, not a sandbox.** Loader plugins run as full-privilege Node in the main
  process (no QuickJS sandbox, no permission gate, no CPU deadline). To keep TronHawk's threat model,
  TronHawk would have to re-impose its own QuickJS sandbox *inside* a host that already holds base
  privileges — a materially different posture than a capped sandbox over a clean seam.
- **Fragile third-party dependency.** The loader's continued availability depends on beating QQ's
  integrity/anti-tamper, per-version; TronHawk cannot own or guarantee it.
- **Target classification unchanged.** QQNT remains a target that actively resists extension. *Who
  performed the bypass does not change the Level 0 / out-of-scope classification.*

**Condition for ever pursuing Mode B.** It is a **product/security policy decision**, not an Injector
adapter concern: explicitly relax "no-disk-mutation" and "no-native-hook", re-define the security model
for plugins that run inside an already-elevated third-party host, and accept device/account banish risk.
Only after such a policy exists is Mode B worth an implementation exploration. Until then it stays a
documented, non-goal note.

## Recommendation

Keep QQNT in **Level 0 / unsupported** and do not build an adapter for it. If product intent later
wants Tencent-ecosystem support at all, that is a separate **policy/security decision** that must first
relax the "no-disk-mutation" and "no-native-hook" invariants and accept the account/device-banish risk —
not something the Injector adapter layer can slip in. **Mode B (third-party-loader piggyback) does not
change this**: it is recorded above for future exploration, but remains a non-goal until the security
policy is explicitly re-decided. Do not treat this as a "shrink the merged asar and it works" follow-up
like ADR 0005; the blocker is systemic, not a single require-guard.

## Sources

- LiteLoaderQQNT (MIT): `README.md`, `src/main.js`, `src/main/hook.js` — github.com/LiteLoaderQQNT/LiteLoaderQQNT
- LiteLoaderQQNT/QQNTFileVerifyPatch — github.com/LiteLoaderQQNT/QQNTFileVerifyPatch (README + issue #1)
- NapNeko/NapCat-Windows-Boot — `main/main.cpp`, `hook/hook.cpp`, `hook.bak.cpp` (native runtime-injection precedent)
- NapNeko/NapCatQQ — `packages/napcat-shell-loader/qqnt.json`, `packages/napcat-shell/process-api.ts`
- Mzdyl/LiteLoaderQQNT_Install — `install_windows.py` (old/new layout, `QQNT.dll`, `launcher.node`)
- shuakami/qq-chat-exporter — `scripts/quick-pack.py` (main/asar/`isPureShell`/`isByteCodeShell`)
- MliKiowa/NTQQAppidQuick — `GetAppid.js` (`QQNT.dll` as a Node-API/V8 host)
- Local: `C:\Program Files\Tencent\QQNT\` (read-only PE/byte/config inspection)

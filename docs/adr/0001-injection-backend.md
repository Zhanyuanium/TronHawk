# ADR 0001 — Injection backend: electron-hook (vendored)

Status: **Accepted** (PoC validated 2026-08-24)

## Context

TronHawk injects a runtime into third-party Electron apps without modifying their files on disk
(SPEC §1 invariant). SPEC §8 proposed `electron-hook`, gated on a pre-production PoC before
committing.

## PoC result

| Item | Result |
|---|---|
| Main-process injection | ✅ `bootstrap.js` ran in the target's main process |
| Renderer control | ✅ `webContents.executeJavaScript` (main world) + `insertCSS` both work |
| Latest Electron | ✅ Electron 43.4.1 / Node 24.18.1 |
| Full Electron API from main | ✅ `require("electron")` returns app / BrowserWindow / webContents |
| Runtime-only | ✅ no target files modified (in-memory ASAR remap) |

## How it works

1. `electron_hook::launch(exe, dll, asar, args, detach)` launches the target with
   `DetourCreateProcessWithDllExA` (`CREATE_SUSPENDED`), injecting our cdylib.
2. The DLL's `DllMain` hooks Win32 file APIs (`CreateFileW`, `GetFileAttributesW`, `MoveFileExW`,
   `uv_fs_lstat`) plus `CreateProcessW` (child re-injection) and `SetAUMID`.
3. The file hooks remap `resources/app.asar` → a modded asar (built via `Asar`) and
   `resources/_app.asar` → the real `app.asar`, all in-memory.
4. Electron loads the modded asar, whose `index.js` runs
   `require(process.env.MODLOADER_MOD_ENTRYPOINT)` → our bootstrap in the main process (full
   Node/Electron access).

## Decisions

1. **Vendoring is required, not just preferred.** electron-hook ships a git submodule (Microsoft
   Detours) + its own `[workspace]` + pins nightly + under-declares `winapi` features. It cannot be
   consumed as a crates.io or git dependency. We vendor into `vendor/electron-hook/` and patch it:
   remove `[workspace]`; add the missing `winapi` features (`fileapi`, `processthreadsapi`,
   `winbase`, `libloaderapi`, `minwinbase`, `winnt`).
2. **Stable Rust suffices.** Upstream pins `nightly` (`rust-toolchain.toml`), but the code
   compiles cleanly on stable 1.97.1 — no nightly requirement.
3. **Packaged apps only.** Injection needs `resources/app.asar`, so targets must be packaged;
   unpackaged dev apps are not injectable through this path.
4. **Renderer (open question #1): main world for MVP.** `webContents.executeJavaScript` (main
   world) and `insertCSS` are validated. Isolated world (preload + `contextBridge`) is a future
   hardening option, not MVP.

## Consequences / follow-ups

- `crates/injector` = a cdylib (`pub use electron_hook::*`) + a launcher binary.
- No special toolchain needed: the injector builds on stable 1.97.1.
- `vendor/electron-hook/` must be committed; trim Detours to `src/` + `LICENSE`.
- Real-target validation (2026-08-24): the installed "ChatGPT" is the `OpenAI.Codex` **MSIX**
  package running a custom "owl" Electron fork (`process.versions.electron = 151.0.7922.170`, a
  4-part non-semver string). Main-process injection succeeds and the original app loads (with a
  `realpathSync` workaround for Electron 151), but the GUI does not fully start under raw-exe
  Detours launch — the MSIX app needs AUMID launch, and raw launch yields `userData`-path,
  `Invalid semantic version`, and registry access-denied errors. MSIX targets are a separate
  category (SPEC §18 application profiles / Explorer mode). Non-MSIX VS Code remains to be tested.
- Keep electron-hook isolated behind the Injector layer (SPEC §17 risk mitigation).

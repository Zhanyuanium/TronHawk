# Third-Party Notices

TronHawk vendors and redistributes the following third-party components. Their full license
texts are included in the repository (see the `License` field for each).

## electron-hook (vendored)

- **Project**: electron-hook — https://github.com/MeguminSama/Electron-Hook
- **Version**: 0.2.2 (commit `c7e55b3d`)
- **License**: LGPL-3.0 (see `vendor/electron-hook/LICENSE`)
- **Source**: vendored in `vendor/electron-hook/` (patched; see `vendor/electron-hook/VENDOR.md`)
- **Note**: electron-hook is linked into the injector cdylib. LGPL-3.0 imposes source-availability
  and (re)linking obligations on distributed binaries; a full compliance review is required before
  any release distribution.

## Microsoft Detours (vendored)

- **Project**: Detours — https://github.com/microsoft/detours
- **License**: MIT (see `vendor/electron-hook/vendor/detours-sys/ext/detours/LICENSE`)
- **Source**: vendored under `vendor/electron-hook/vendor/detours-sys/ext/detours/`

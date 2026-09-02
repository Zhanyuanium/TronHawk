# Third-Party Notices

This file is TronHawk's third-party compliance pack. It identifies every
third-party component TronHawk redistributes, states the license posture of the
distributed binaries, preserves the required notices, and gives the
source-availability and relink information required by the GNU Lesser General
Public License version 3.

License texts live next to their components and are never reproduced here, so
the shipped copies stay verbatim:

| Component | License | Where the license text lives |
|---|---|---|
| TronHawk original code | Apache-2.0 | `LICENSE` (repository root) |
| electron-hook (vendored, patched) | LGPL-3.0 | `vendor/electron-hook/LICENSE` |
| GNU GPL-3.0 companion text (required by LGPL-3.0 section 4(b)) | GPL-3.0 | `LICENSE.GPL-3.0` (repository root) |
| Microsoft Detours (vendored via electron-hook) | MIT | `vendor/electron-hook/vendor/detours-sys/ext/detours/LICENSE` |

## 1. electron-hook — LGPL-3.0 notice (LGPL-3.0 section 4(a))

- **Project**: electron-hook — https://github.com/MeguminSama/Electron-Hook
- **Version**: 0.2.2 (upstream commit `c7e55b3d`)
- **License**: GNU Lesser General Public License, version 3 (LGPL-3.0)
- **Source**: vendored, patched, under `vendor/electron-hook/` (see
  `vendor/electron-hook/VENDOR.md` for the patch log)

Prominent notice for users of TronHawk binaries:

> TronHawk redistributes the library **electron-hook**, which is a separately
> identifiable library covered by the GNU Lesser General Public License version
> 3 (LGPL-3.0). The library is used in, and statically linked into, the
> distributed TronHawk binary `tronhawk_injector.dll` (a Combined Work under
> LGPL-3.0 section 4). A user who modifies the library or the Combined Work is
> not excused from the LGPL-3.0 obligations that apply to conveying it. See
> `vendor/electron-hook/LICENSE` for the LGPL-3.0 text, `LICENSE.GPL-3.0` for
> the GNU GPL-3.0 text, and section 3 below for Corresponding Source and relink
> information.

## 2. Why the GNU GPL-3.0 text is shipped (LGPL-3.0 section 4(b))

LGPL-3.0 section 4(b) requires that a Combined Work be accompanied by a copy of
**both** the GNU GPL and the GNU LGPL license documents. The LGPL-3.0 text is
preserved at `vendor/electron-hook/LICENSE` (the upstream copy). The GNU
GPL-3.0 text is provided at `LICENSE.GPL-3.0` in the repository root. Any
distribution that includes a TronHawk binary embedding electron-hook must carry
both texts (see the distribution checklist in section 5).

## 3. Combined Work, Corresponding Source, and relinking (LGPL-3.0 section 4(d)(0))

`crates/injector` builds a Windows `cdylib`, `tronhawk_injector.dll`, and
re-exports the vendored library with `pub use electron_hook::*`, which compiles
electron-hook's `DllMain` hook (and its Microsoft Detours dependency) **into the
same binary**. This is a static link: electron-hook is not a separate shared
library that could be swapped out, so TronHawk does **not** claim the
shared-library path of LGPL-3.0 section 4(d)(1). The applicable obligation is
LGPL-3.0 section 4(d)(0): convey the Minimal Corresponding Source and make the
Corresponding Application Code available in a form suitable for the user to
relink the Combined Work.

- **Minimal Corresponding Source** = `vendor/electron-hook/`. It is the complete
  buildable source of the LGPL-3.0-covered library as distributed by TronHawk.
  TronHawk's modifications are recorded as a patch log in
  `vendor/electron-hook/VENDOR.md`; the unmodified upstream baseline is
  electron-hook 0.2.2 at commit `c7e55b3d`. Reverting the `VENDOR.md` patches to
  that commit reproduces the pristine upstream source.
- **Corresponding Application Code** = `crates/injector/` plus the workspace
  root `Cargo.toml` and `Cargo.lock`. This is the code that relinks the library
  into the Combined Work. TronHawk's own code there is licensed Apache-2.0
  (`LICENSE`) and is relink-permissive: nothing in TronHawk's license restricts
  a user from relinking it with a modified library.
- **Installation Information** (the information required to install and execute
  a modified version of the Combined Work) is the build/relink procedure below.

### Build and relink instructions (Installation Information)

```sh
# Prerequisites: a stable Rust toolchain (MSVC host) on Windows x64.
#
# 1. Modify the Minimal Corresponding Source (vendor/electron-hook/) and/or the
#    Corresponding Application Code (crates/injector/) as you need. Keep the
#    patch log in vendor/electron-hook/VENDOR.md up to date so your changes stay
#    identifiable against the c7e55b3d upstream baseline.
#
# 2. Rebuild the injector cdylib from the workspace root:
cargo build -p tronhawk-injector          # debug  -> target/debug/tronhawk_injector.dll
cargo build --release -p tronhawk-injector # release -> target/release/tronhawk_injector.dll
#
# 3. Replace the tronhawk_injector.dll in your TronHawk installation with the
#    rebuilt binary, then relaunch the target Electron application. The modified
#    Combined Work takes effect on the next injection.
```

Conveyors of the Combined Work must provide the Minimal Corresponding Source
under LGPL-3.0; modified versions of the LGPL-3.0-covered library must be
conveyed under LGPL-3.0. Modifications confined to the Apache-2.0 application
code (`crates/injector/` and friends) do not fall under the LGPL. Nothing in
TronHawk's licenses or distribution terms forbids reverse engineering or
debugging of the Combined Work for the purpose of relinking under the LGPL.

## 4. Microsoft Detours (MIT)

- **Project**: Detours — https://github.com/microsoft/detours
- **License**: MIT (see
  `vendor/electron-hook/vendor/detours-sys/ext/detours/LICENSE`)
- **Source**: vendored (trimmed to `src/` + license files) under
  `vendor/electron-hook/vendor/detours-sys/ext/detours/`

The MIT license notice and copyright statement are preserved verbatim in the
`LICENSE` file at the path above. Detours is an MIT-licensed dependency of
electron-hook; MIT requires notice only, which this section and the preserved
file provide.

## 5. Distribution checklist

When distributing TronHawk binaries (for example an MSI/NSIS installer that
contains `tronhawk_injector.dll`), include, in or alongside the distribution:

1. This file (`THIRD_PARTY_NOTICES.md`) with the section 1 notice intact.
2. The Apache-2.0 text (`LICENSE`) — TronHawk's original code.
3. The GNU GPL-3.0 text (`LICENSE.GPL-3.0`) — required by LGPL-3.0 section 4(b).
4. The LGPL-3.0 text (`vendor/electron-hook/LICENSE`).
5. The MIT notice for Microsoft Detours (section 4).
6. The provenance notice (`NOTICE`).
7. The Corresponding Source pointers and the build/relink instructions of
   section 3, so recipients can relink the Combined Work.

Source distributions of the TronHawk repository satisfy items 1-7 by
construction.

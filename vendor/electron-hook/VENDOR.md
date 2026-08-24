# Vendored electron-hook 0.2.2

Source: https://github.com/MeguminSama/Electron-Hook (commit `c7e55b3d`, crate 0.2.2)

## Why vendored

Upstream cannot be consumed as a crates.io or git dependency because it:

- ships Microsoft Detours as a git submodule (`vendor/detours-sys/ext/detours`),
- declares its own `[workspace]` (conflicts with our root workspace),
- under-declares `winapi` features (relies on downstream feature unification).

## Patches applied

1. Removed the `[workspace]` section from `Cargo.toml`.
2. Added missing `winapi` features: `fileapi`, `processthreadsapi`, `winbase`,
   `libloaderapi`, `minwinbase`, `winnt`.
3. Trimmed Detours to `src/` + license files (dropped `samples/`, `tests/`, `vc/`, `.github/`).
4. Removed a `libc::O_CLOEXEC` assertion in `src/paths.rs` tests (Unix-only constant, fails on
   Windows `libc`).

## License

electron-hook is LGPL-3.0; Microsoft Detours is MIT. See the respective LICENSE files.

See `docs/adr/0001-injection-backend.md` for the full rationale.

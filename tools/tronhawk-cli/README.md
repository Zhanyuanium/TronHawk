# @tronhawk/cli

Standalone TronHawk plugin CLI (bun package). It never decides plugin legitimacy:
every authoritative check runs in the same-version Rust engine (`tronhawk-pack` from
`crates/package`). When the native engine is missing, mismatched, or unsupported the
CLI hard-fails with install guidance and never falls back to a TypeScript packer.

> Three versions are managed independently (never assume equality, even when all
> three are `0.1.0` today; missing fields fail instead of being derived):
> - CLI version — this package's `version`.
> - Engine version — `tronhawk.engineVersion` in this package, must exactly
>   match `tronhawk-pack --version` (explicit assertion at resolve time).
> - Protocol version — `tronhawk.protocolVersion` in this package, the host
>   runtime protocol the CLI was built against; the authoritative default lives in the
>   Rust engine (`HOST_PROTOCOL_VERSION`). Pass `--host-version` to check another host.
> Release-tag / package / engine consistency is only ever an explicit assertion
> (`assertReleaseTagMatches`); the CLI never derives one version from another.

## Commands

```sh
tronhawk build <plugin-dir> [--outdir <dir>]
tronhawk validate <plugin-dir> [--host-version <ver>] [--json]
tronhawk pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]
tronhawk inspect <file.thx> [--host-version <ver>] [--json]
  tronhawk test <plugin-dir> [--sandbox]
tronhawk --version [--json]
tronhawk --help | -h | help [<command>]
```

- `build`: bundle TS (`src/*.ts`) to single-file CommonJS (`dist/*.js`). Rejects
  unresolved externals, residual bare `require(...)`, and `exports.default` (the
  QuickJS host reads `module.exports.activate` / `deactivate`). A TS source using
  `export default` is bridged via a temp wrapper so the output is still
  `module.exports = { activate, deactivate }`. Entry code loads only in an
  isolated subprocess (stdio captured, timeout kill, exit code untrusted); a
  top-level `process.exit(0)` fails closed and can never skip Rust.
- `validate`: authoritative check only — resolves the same-version native engine snapshot and
  execs `tronhawk-pack validate`. JS output is never treated as valid by itself.
- `pack`: CSS-aware. JS entries go `build` (isolated) → `smoke` (isolated) →
  minimal staging (`manifest.json` + `dist/*.js` + declared CSS / `assets/`); CSS-only
  plugins skip `build` with an explicit notice but still run staging. Then a single
  Rust `pack <staging> <output.thx>` decides publish (temp file + same-crate
  round-trip + atomic rename all inside Rust; the CLI keeps no outer duplicate).
  Pack succeeds iff Rust exits 0. `--json` prints exactly one JSON document from
  Rust (no second CLI summary). No TypeScript fallback packer exists: without the
  native engine, `pack` fails.
- `inspect`: passthrough to `tronhawk-pack inspect` (behavior defined by Rust).
- `test`: basic smoke only, loaded in the isolated subprocess (entry
  `module.exports.activate` / `deactivate` existence + lifecycle shape). It never
  substitutes for `validate`. With `--sandbox`, built entries additionally execute
  in the canonical QuickJS contract harness (same loading convention as the host:
  hook shape, no ESM/`require` leftovers, no Node/Electron globals, lifecycle and
  permission-denied behavior). The harness ships inside the CLI package with its
  QuickJS runtime dependency, so `--sandbox` also works in tarball installs
  outside any checkout.

## Native engine resolution

Trusted sources only (no PATH search; the generic `pack` name is never
auto-discovered — it runs only via an explicit path):

1. `TRONHAWK_PACK_BIN` (explicit, highest priority),
2. explicit config `tronhawk.packBin` in this package's `package.json`
   (or a `packBin` passed programmatically),
3. workspace `target/{release,debug}/tronhawk-pack(.exe)` (local cargo build).

- Missing binary, version mismatch (expected `tronhawk.engineVersion` via explicit
  `!==`), digest mismatch, or an unsupported `<platform>-<arch>` (supported:
  `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`,
  `darwin-arm64`) all hard-fail with guidance:
  `cargo build -p tronhawk-package --release` from the TronHawk repo root, or set
  `TRONHAWK_PACK_BIN`.
- Digest sidecar (`<bin>.sha256`): only a missing sidecar with `ENOENT` skips the
  check (dev builds). An empty, malformed, or unreadable (non-`ENOENT`) sidecar
  hard-fails, as does any mismatch.
- After verification the binary is copied to a process-private snapshot
  (`os.tmpdir()/tronhawk-engine-*`, hash-compared); `version` / `pack` / `inspect`
  all exec the snapshot, never the original path (TOCTOU closed).

## Staging

Every source path is canonicalized (`realpath`) and must stay inside the plugin
root (`..` / absolute / symlink escapes fail). Every staged target
(`manifest.json`, `dist/*.js`, CSS, `assets/*`) is tracked for uniqueness (exact +
case-folded); any collision fails.

## Exit codes

- `0` success.
- `1` operation failure (build/smoke failure, Rust rejection, missing/mismatched
  native engine).
- `2` usage error.

# THX Format (v1)

`.thx` is the v1 plugin package: a deterministic ZIP archive plus a validated
`manifest.json`. The single source of truth is `crates/package` (`src/lib.rs`:
`pack` / `extract` / `validate_manifest_schema`); this document summarizes the
contract for plugin authors and reviewers.

## 1. Logical ZIP layout

- A `.thx` file is a ZIP (deflated entries) whose root contains `manifest.json`
  plus the files it references.
- `pack` collects **every regular file** under the plugin directory
  recursively, sorts entries by path, and writes ZIP names with `/` separators.
  Directory structure is preserved; there is no build output directory and no
  manifest-declared file list beyond `entry` (unreferenced files still ship).
- Typical layout:

  ```text
  plugin.thx (ZIP)
  ├── manifest.json
  ├── style.css            # when entry.css is declared
  ├── src/renderer.js      # when entry.renderer is declared
  └── src/main.js          # when entry.main is declared
  ```

- Limits (fail-at-start on extract): at most **1000 entries**; each entry at
  most **16 MiB** uncompressed; **64 MiB** total uncompressed;
  `manifest.json` at most **1 MiB**; per-entry and cumulative compression
  ratio capped at **100×** (a small compressed payload must not expand beyond
  100× even under the byte caps).

## 2. `manifest.json` and schema

Top-level shape (unknown fields are rejected):

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "author": "Example",
  "tronhawk": "^0.1",
  "permissions": ["renderer.css", "renderer.script"],
  "entry": { "css": "style.css", "renderer": "src/renderer.js" }
}
```

- Required: `id`, `name`, `version`, `author`, `tronhawk`.
  - `id`: 1–128 chars; lowercase ASCII letters/digits plus `.`/`-`/`_`;
    no empty dot-segments (`.`-separated labels must all be non-empty).
  - `name` / `author`: must be non-empty after trimming.
  - `version`: semver (`0.1.0`).
  - `tronhawk`: semver range (see §3).
- Optional:
  - `permissions`: array of known permission strings (default `[]`); unknown
    or duplicate entries are rejected. Known values:
    `renderer.css`, `renderer.script`, `renderer.dom`, `renderer.storage`,
    `electron.window`, `electron.windowControls`, `electron.webContents`,
    `electron.session`, `electron.ipc`, `network.access`, `network.proxy`,
    `runtime.unsafe`.
  - `css` (inline CSS string) **or** `entry.css` (CSS file path) — the two are
    mutually exclusive. A CSS source requires the `renderer.css` permission.
    CSS is **data** injected via `insertCSS`, never executed as JS.
  - `entry.renderer` / `entry.main`: JS file paths. A `renderer` entry
    requires `renderer.script` at pack time — the declaration is mandatory even
    when the runtime escape hatch applies. At runtime `renderer.script` is the
    execution gate for renderer JS (an effective `renderer.script` grant or the
    Developer-mode `runtime.unsafe` escape hatch; `renderer.dom` /
    `renderer.storage` / `renderer.css` / `electron.windowControls` are additional
    capabilities only and never substitute for the gate at either layer; without
    the gate Core `execution_plan` drops the renderer payload and records
    `core.renderer.script_required`). Entries are executable
    **CommonJS** (`module.exports.activate` / `deactivate`); ESM
    (`export default`) is never loaded by the host.
  - `config`: per-plugin settings schema, an object of at most **32** fields.
    Each key follows the same character rules as `id`. Each field is
    `{ "type": "string" | "number" | "boolean", "default"?, "label"? }` —
    no other keys. `object`/`array` types are rejected as reserved for a
    future schema version. A present non-`null` `default` must match the
    declared `type` (`null` means "no default"). `label`, when present, must
    be a non-empty string of at most 64 chars.
  - `network`: outbound allowlist `{ "domains": [...] }` for `network.access`
    (`domains` is the only allowed key; at most **64** entries). Each entry is
    a hostname, `host[:port]`, plain IPv4, or leading-`*.` wildcard hostname
    (e.g. `*.example.com`); schemes, paths, credentials (`@`), IPv6 literals,
    and bare `*` are rejected. Ports must be 1–65535. Entries are lowercased
    during validation; duplicates after case-folding are rejected. A plugin
    with `network.access` but no/empty allowlist fails closed at request time.
- Entry paths must be safe relative paths (only normal components — no
  absolute paths, no `..`, no escape from the plugin directory). They are
  resolved within the plugin root at pack/extract time and must resolve to a
  file inside it.

## 3. Host protocol gate

- The `tronhawk` field is the **host runtime protocol version** the plugin
  targets (a semver `VersionReq`, e.g. `"^0.1"`). It is **not** the
  `@tronhawk/sdk` npm version; the two evolve independently.
- The host implements protocol `HOST_PROTOCOL_VERSION` (currently `0.1.1`).
  `validate_manifest_schema_for_host` / `extract_for_host` reject a plugin
  whose range does not match the running host **before anything is written to
  disk or installed**, naming both sides
  (e.g. ``plugin requires tronhawk protocol `^0.2` but host protocol is 0.1.1``).
- Callers that know a different host version pass it explicitly; the crate
  never hardcodes the check.

## 4. File-safety rules

Pack time (`pack`):

- The plugin is validated (`load_plugin_dir`: manifest schema + entry files
  resolve and read) **before** packing; an invalid plugin never produces an
  archive.
- **Symlinks are refused**: any symlink (file or dir) under the source tree
  aborts packing (`refusing to pack symlink: …`). Remove `node_modules`
  (which contains a symlinked `@tronhawk/sdk`) before packing.
- The output `.thx` must not be inside the source directory.

Extract/install time (`extract` / `extract_for_host`, fail-at-start — every
rejection below happens in Phase 1/1b, before a single byte is written):

- Manifest schema + protocol gate are checked **before** extraction.
- Archive hardening for **every** entry before extraction: entry count/size/
  compression-ratio caps (§1); duplicate detection (byte-identical duplicates
  are rejected via a central-directory scan because the ZIP reader would
  otherwise silently collapse them last-wins; names colliding only after
  case-folding/normalization are rejected as unsafe on case-insensitive
  filesystems); Windows hardening (empty names/segments, `:` ADS syntax,
  segments ending in `.`/space, reserved device names `CON`/`PRN`/`AUX`/
  `NUL`/`CONIN$`/`CONOUT$`/`COM1`–`COM9`/`LPT1`–`LPT9` including superscript
  variants, matched on the stem before the first `.`, case-insensitively).
- Path containment: every entry name must consist of normal components only
  (no absolute paths, no `..`, no drive/UNC syntax) and is joined via
  `safe_join`; anything escaping `dest` is rejected.
- After extraction, full validation re-runs (entry files resolved and read),
  so a manifest referencing a missing/escaping file fails the install.

Packing and extraction never execute package code: only `manifest.json` is
parsed and entry files are read as text.

## 5. Compatibility policy

- **No new required fields.** Manifests written before an optional field
  existed stay loadable: absent `permissions`/`entry`/`config`/`network`
  default to empty; explicit `"config": null` loads as an empty schema and
  `"network": null` as absent. New capabilities arrive as new optional fields
  and/or new permission strings gated by the `tronhawk` protocol range — old
  hosts reject what they do not understand via the protocol gate instead of
  mis-parsing it.
- Unknown top-level/entry/config/network keys are rejected (fail closed),
  so a future schema version must be introduced alongside a protocol bump,
  never by silently ignoring fields.
- Size/archiving limits are host-enforced caps, not part of the package ABI;
  tightening them rejects hostile archives without changing what a valid v1
  package looks like.

## 6. Security assumptions (独立 CLI 使用前提)

The standalone CLI (`tools/tronhawk-cli`: `build` → staging → a single
Rust `pack`; the authoritative checks always run in the same-version Rust
engine — JS results only decide whether to continue, never to publish) is
for personal developer/geek use. It commits only to a **trusted, quiescent,
symlink-free local plugin worktree**: the files under the plugin directory
are yours, no other process modifies them while `build`/`pack` runs (no
concurrent modification), and the tree contains no symlinks (cf. §4 —
symlinks are refused wherever the CLI looks, but the CLI does not promise
to make a hostile tree safe).

The following three are **known accepted risks** (Gate 2 residual, option A —
documented here, behavior unchanged):

- **Per-entry validate-then-build (`build`): the first valid entry already
  lands in `dist/`.** `build` resolves, bundles, and writes each
  `entry.renderer` / `entry.main` in turn; a later entry that fails
  containment/bundling/shape checks aborts the run but does not roll back
  the earlier `dist/*.js` output. Re-run `build` after fixing the
  manifest/source; never pack a half-built `dist/`.
- **Default `dist/` symlink writes through.** The default output directory
  `<plugin>/dist` itself is not symlink-guarded (only the manifest, the
  sources, and the staged targets are canonicalized and required to stay
  inside the plugin root): if `dist` is a symlink pointing outside the root,
  `build` follows it and writes outside. Keep `dist/` a real directory you
  created (or pass an explicit trusted `--outdir`); do not build in a tree
  whose `dist` you did not create.
- **Successful engine snapshot lingers on abnormal termination (normal exit
  cleans).** `resolveNative` execs a process-private snapshot copy
  (`os.tmpdir()/tronhawk-engines-*`), re-hashed after copying; snapshots
  that fail verification are deleted immediately and live snapshots from
  successful resolutions are removed on process exit — but a kill that
  bypasses exit handlers (`SIGKILL`, crash, power loss) leaves the snapshot
  for OS temp reclamation. This never affects correctness (only verified
  bytes are ever exec'd); wipe the temp directory if the residue bothers you.

Anything outside this premise — a concurrently modified tree, an
untrusted/shared directory, a tree you have not rid of symlinks — is out of
scope for the standalone CLI: **use the monorepo flow instead** (run
`cargo run -p tronhawk-package --bin pack` from the TronHawk repo root; see
`docs/PLUGIN-SDK.md` § Build and pack, and §4 above for the pack/extract
file-safety rules that still decide every install).

## References

- Implementation: `crates/package/src/lib.rs`, CLI: `crates/package/src/bin/pack.rs`
- Plugin API contract: `docs/PLUGIN-SDK.md`
- Registry metadata (catalog contract, future store): `docs/PLUGIN-REGISTRY.md`

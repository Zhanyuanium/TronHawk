# @tronhawk/cli-create-plugin

Scaffold a new [TronHawk](https://github.com/TronHawk) plugin project: `package.json`,
`tsconfig.json`, a `manifest.json`, and executable CommonJS starter sources
(`src/renderer.js` / `src/main.js`, loaded directly by the QuickJS host).

Requires [bun](https://bun.sh) (the repo's JS toolchain). The CLI is a bun package with no
runtime dependencies; it runs the scaffold templates directly.

## Usage

Standalone (from the npm registry; works outside any TronHawk checkout):

```sh
bunx @tronhawk/cli-create-plugin plugins/my-plugin          # renderer starter (default)
bunx @tronhawk/cli-create-plugin plugins/window-tint --type main --author "Ada"
```

Directly via the source entry (contributors inside a checkout, works from anywhere):

```sh
bun ./tools/create-tronhawk-plugin/src/cli.ts plugins/my-plugin --type renderer
```

Or install the package once to get a global `create-tronhawk-plugin`
(`bun add -g @tronhawk/cli-create-plugin`, then run `create-tronhawk-plugin <name>`
from any directory).

The generic usage is:

```sh
create-tronhawk-plugin [options] <name-or-dir>
```

| Option | Meaning |
|---|---|
| `--type <css\|renderer\|main>` | Starter template. Default: `renderer`. |
| `--name <display>` | Manifest `name`. Default: derived from the directory name. |
| `--author <author>` | Manifest `author`. Default: `git config user.name`, else `Example`. |
| `--id <id>` | Manifest plugin id (reverse-DNS, lowercase). Default: `com.example.<name>`. |
| `--sdk <spec>` | Dependency spec for `@tronhawk/sdk`. Default: see below. |
| `--force` | Replace a non-empty target directory. |
| `-h, --help` | Print usage. |
| `-v, --version` | Print the CLI version. |

`<name-or-dir>` is either a plugin name (a directory is created in the current folder) or a
target directory path. The target must not exist yet, or must be empty unless `--force` is
given. Scaffolding into the current directory, an ancestor, or the filesystem root is refused.

### Examples

```sh
# Renderer plugin (page CSS + renderer script) in ./dark-scrollbar
create-tronhawk-plugin dark-scrollbar

# Main-process plugin in a plugins folder
create-tronhawk-plugin plugins/window-tint --type main --author "Ada"

# CSS-only theme into a temp dir (--force overwrites)
create-tronhawk-plugin ./tmp/theme --type css --force
```

## What gets scaffolded

```
my-plugin/
├── package.json       # bun package: tronhawk-plugin-<name>, typecheck script (no build step)
├── tsconfig.json      # strict TS, noEmit, allowJs/checkJs (mirrors the in-repo plugin convention)
├── manifest.json      # id, name, version, author, tronhawk "^0.1", entry, permissions
├── README.md
├── .gitignore
├── style.css          # css & renderer types: page theme referenced by entry.css
└── src/
    ├── renderer.js    # renderer type: active CommonJS entry; others: commented starter
    └── main.js        # main type: active CommonJS entry; others: commented starter
```

Runtime entries are executable CommonJS: the QuickJS host evaluates the entry
with `module`/`exports` scaffolding and reads
`module.exports.activate`/`deactivate`. TypeScript ESM (`export default`) is
never loaded directly — `entry.renderer` / `entry.main` must point at `.js`.

Per type, `manifest.json` is generated as:

| `--type` | `entry` | `permissions` |
|---|---|---|
| `css` | `{ "css": "style.css" }` | `["renderer.css"]` |
| `renderer` (default) | `{ "css": "style.css", "renderer": "src/renderer.js" }` | `["renderer.css", "renderer.script"]` |
| `main` | `{ "main": "src/main.js" }` | `["electron.window"]` |

The `tronhawk` field is the TronHawk **runtime protocol version** (`"^0.1"`), not the SDK npm
version. The SDK dependency (`@tronhawk/sdk`) provides the TypeScript API
surface plus testing helpers (`createMockRendererContext`,
`createMockMainContext`, `createLogger`, `injectCSS`) — no host runtime and no
packer; packing goes through the standalone `@tronhawk/cli` (`tronhawk`
binary) and the same-version native `tronhawk-pack` engine (see below).

## `@tronhawk/sdk` / `@tronhawk/cli` dependency resolution

Both default to the npm registry release line (`^0.1.0`, kept in sync with
`sdk/package.json` and `tools/tronhawk-cli/package.json`). Pass `--sdk` /
`--cli` at scaffold time to override (e.g. `--sdk file:/path/to/sdk.tgz` or
`--cli file:/path/to/tronhawk-cli.tgz` for unpublished tarballs). The
scaffolder never emits `workspace:*` or a local `file:` probe by default, so
an external plugin cannot be masked by a checkout.

## Packing to `.thx`

Every type packs through the unified CLI command (CSS-only skips `build`
explicitly — `style.css` ships as data — but still runs staging and the
same-version Rust/SHA path; never invoke the engine binary directly):

```sh
cd <plugin-dir> && bun install
bun run build            # tronhawk build .: bundle entries to dist/ (CSS-only: no build step)
tronhawk test . --sandbox  # QuickJS contract harness (ships inside the CLI, no checkout needed)
tronhawk validate .      # authoritative dir check (writes nothing)
tronhawk pack . <name>.thx
tronhawk inspect <name>.thx
```

The CLI needs the same-version native engine: set `TRONHAWK_PACK_BIN` to the
`tronhawk-pack` release binary (explicit, highest priority), configure
`tronhawk.packBin`, or build it inside a TronHawk checkout (`cargo build -p
tronhawk-package --release`, resolved from
`target/{release,debug}/tronhawk-pack`). The CLI's `tronhawk.engineVersion`
must exactly match `tronhawk-pack --version`; a missing binary, digest
mismatch, or version mismatch hard-fails with install guidance — there is no
TypeScript fallback packer and no PATH search for the engine.

Alternative (contributors inside a TronHawk monorepo checkout, from the repo
root only):

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <plugin-dir>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <plugin-dir> <out.thx>
```

The packer validates `manifest.json` and its entry files, then packs every file
in the folder — it **refuses symlinks**, so remove the plugin's `node_modules`
before packing when calling the engine directly. The scaffolded
`README.md` documents the exact commands; the `.thx` artifact is git-ignored.
See `docs/THX-FORMAT.md` for the `.thx` layout and file-safety rules.

## Development

```sh
bun install       # once (workspace member of the repo root package.json)
bun test          # smoke tests: scaffolds into temp dirs, asserts manifest + sources
bun run typecheck # tsc --noEmit
bun run build     # bundle the CLI to dist/ (informational; bin runs the TS source directly)
```

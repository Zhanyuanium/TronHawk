# @tronhawk/cli-create-plugin

Scaffold a new [TronHawk](https://github.com/TronHawk) plugin project: `package.json`,
`tsconfig.json`, a `manifest.json`, and TypeScript starter sources.

Requires [bun](https://bun.sh) (the repo's JS toolchain). The CLI is a bun package with no
runtime dependencies; it runs the scaffold templates directly.

## Usage

From the monorepo root (the package is a bun workspace member):

```sh
bun run create-tronhawk-plugin -- plugins/my-plugin          # renderer starter (default)
bun run create-tronhawk-plugin -- plugins/window-tint --type main --author "Ada"
```

Directly via the source entry (works from anywhere):

```sh
bun ./tools/create-tronhawk-plugin/src/cli.ts plugins/my-plugin --type renderer
```

Or link the package once to get a global `create-tronhawk-plugin` on your PATH
(`bun link` inside `tools/create-tronhawk-plugin`, then run `create-tronhawk-plugin <name>`
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

# Main-process plugin inside the monorepo's plugin folder
create-tronhawk-plugin plugins/window-tint --type main --author "Ada"

# CSS-only theme into a temp dir (--force overwrites)
create-tronhawk-plugin ./tmp/theme --type css --force
```

## What gets scaffolded

```
my-plugin/
├── package.json       # bun package: tronhawk-plugin-<name>, typecheck/build scripts
├── tsconfig.json      # strict TS, noEmit (mirrors the in-repo plugin convention)
├── manifest.json      # id, name, version, author, tronhawk "^0.1", entry, permissions
├── README.md
├── .gitignore
├── style.css          # css & renderer types: page theme referenced by entry.css
└── src/
    ├── renderer.ts    # renderer type: active; others: commented starter
    └── main.ts        # main type: active; others: commented starter
```

Per type, `manifest.json` is generated as:

| `--type` | `entry` | `permissions` |
|---|---|---|
| `css` | `{ "css": "style.css" }` | `["renderer.css"]` |
| `renderer` (default) | `{ "css": "style.css", "renderer": "src/renderer.ts" }` | `["renderer.css", "renderer.script"]` |
| `main` | `{ "main": "src/main.ts" }` | `["electron.window"]` |

The `tronhawk` field is the TronHawk **runtime protocol version** (`"^0.1"`), not the SDK npm
version. The SDK dependency (`@tronhawk/sdk`) is the TypeScript API surface only.

## `@tronhawk/sdk` dependency resolution

The SDK is not published to a registry (it is `private` in the monorepo), so the CLI picks the
dependency spec that will actually work where you scaffold:

- Target directory is a workspace member folder inside the monorepo
  (`plugins/*` or `tools/*`) → `"@tronhawk/sdk": "workspace:*"`.
- Target directory anywhere else on the same drive → a relative
  `"file:../../sdk"` spec that resolves to the local SDK (detected by walking up from the CLI).
- Otherwise `workspace:*` with a note — pass `--sdk` to override, e.g.
  `--sdk file:../path/to/sdk` or a registry spec once the SDK is published.

## Packing to `.thx`

Packing is a Rust binary (`crates/package`), invoked from the monorepo as
`cargo run -p tronhawk-package --bin pack -- <plugin-dir> <out.thx>`. The packer validates
`manifest.json` and its entry files, then packs every file in the folder — it **refuses
symlinks**, so remove the plugin's `node_modules` (which contains a symlinked
`@tronhawk/sdk`) before packing. The scaffolded `README.md` documents the exact commands;
the `.thx` artifact is git-ignored.

## Development

```sh
bun install       # once (workspace member of the repo root package.json)
bun test          # smoke tests: scaffolds into temp dirs, asserts manifest + sources
bun run typecheck # tsc --noEmit
bun run build     # bundle the CLI to dist/ (informational; bin runs the TS source directly)
```

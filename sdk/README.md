# @tronhawk/sdk

TypeScript API for [TronHawk](https://github.com/Zhanyuanium/TronHawk) plugins: context types plus testing helpers. No host runtime, no packer.

> Version `0.2.0` is the first usable but incomplete release. Only the APIs listed below as implemented are wired into the host runtime. The authoritative contract lives in `docs/PLUGIN-SDK.md` in the TronHawk repo.
>
> 中文版见 [README.zh-CN.md](./README.zh-CN.md)。

## Install

```sh
bun add @tronhawk/sdk
```

Requires `bun` (the repo's JS toolchain). No runtime dependencies.

## Quick start

Scaffold a plugin (standalone; works outside any TronHawk checkout):

```sh
create-tronhawk-plugin plugins/my-plugin --type renderer
# --type css | renderer (default) | main
```

Or add the SDK to an existing plugin and import types only:

```ts
import type { PluginModule, RendererContext } from "@tronhawk/sdk";

const plugin: PluginModule<RendererContext> = {
  activate(ctx) {
    ctx.logger.info("hello");
    ctx.css.insert("body { background: #111; }");
  },
  deactivate(ctx) {
    ctx.logger.info("bye");
  },
};

export default plugin;
```

Main-process plugin:

```ts
import type { MainContext, PluginModule } from "@tronhawk/sdk";

const plugin: PluginModule<MainContext> = {
  activate(ctx) {
    ctx.window.onCreated((win) => {
      ctx.window.setOpacity(win, 0.9);
    });
  },
  deactivate() {},
};

export default plugin;
```

> The snippets above are TypeScript sources for type-checking. The file the
> host actually loads (`entry.renderer` / `entry.main`) must be executable
> CommonJS (`module.exports = { activate, deactivate }`) — ESM
> (`export default`) is never executed directly. The scaffolder generates
> `src/renderer.js` / `src/main.js` in that form.

## What the SDK provides

- `PluginContext`: `logger`, `network` (domain-whitelisted, `network.access`), `config` (read via Manager snapshot; `set` is a no-op for sandboxed plugins).
- `RendererContext`: `css.insert/remove` (`renderer.css`), `script.setDocumentTitle` (`renderer.script`), `dom.query/observe` (`renderer.dom`, serialized snapshots, 500 ms cadence), `storage.get/set` (`renderer.storage`, renderer-only, host-namespaced per plugin).
- `MainContext`: `window.onCreated/setOpacity/setSize/setPosition/setVibrancy/setMica` (`electron.window`), `onLoad/onRendererReady/onUnload` lifecycle events (main-root, synchronous `undefined` callbacks, fail-closed unregister).
- Testing helpers (no host required): `createMockRendererContext`, `createMockMainContext`, `createLogger`, `injectCSS`. Use them for unit tests outside the TronHawk host.

What the SDK does NOT provide: no host runtime (no QuickJS sandbox, no
`ctx` implementation outside mocks), and no `.thx` packer. Packing is
decided by the same-version native `tronhawk-pack` engine through the
standalone `@tronhawk/cli` (`tronhawk` binary).

Standalone toolchain (works outside any TronHawk checkout):

```sh
create-tronhawk-plugin my-plugin --type renderer
cd my-plugin && bun install
bun run build            # tronhawk build .: bundle entries to dist/ (CSS-only: no build step, style.css ships as data)
bun test                 # starter smoke test against SDK mocks (no host)
./node_modules/.bin/tronhawk test . --sandbox  # QuickJS contract harness (ships inside the CLI, no checkout needed)
./node_modules/.bin/tronhawk validate .      # authoritative dir check (writes nothing)
bun run pack             # tronhawk pack . my-plugin.thx (or ./node_modules/.bin/tronhawk pack . my-plugin.thx)
./node_modules/.bin/tronhawk inspect my-plugin.thx
```

How to invoke `tronhawk`: `tronhawk` is a devDependency binary
(`node_modules/.bin/tronhawk[.exe]`), not on `PATH`. A bare `tronhawk validate .`
fails with "command not found" — `bun run <script>` resolves `.bin` automatically, a
bare command does not. Pick one: (1) `./node_modules/.bin/tronhawk …` (most reliable,
used above); (2) add `.bin` to `PATH` for this shell session only; (3) put the command
in `package.json` `scripts` and run `bun run <script>` (recommended for repeated use;
`build`/`pack` already work this way). Add scripts for the commands you run often, e.g.
`{ "scripts": { "validate": "tronhawk validate .", "sandbox": "tronhawk test . --sandbox" } }`,
then `bun run validate` / `bun run sandbox`. See `tools/tronhawk-cli/README.md`
§ How to invoke `tronhawk`.

The CLI resolves the engine from trusted sources only (no PATH search), highest first:
`TRONHAWK_PACK_BIN` (explicit, highest priority), explicit config
`tronhawk.packBin`, or `target/{release,debug}/tronhawk-pack(.exe)` from a
local cargo build. Set `TRONHAWK_PACK_BIN` to the same-version
`tronhawk-pack` release binary — the CLI's `tronhawk.engineVersion` must
exactly match `tronhawk-pack --version`; a missing binary, digest mismatch,
or version mismatch hard-fails with install guidance (there is no TypeScript
fallback packer). CSS-only plugins skip `build` explicitly but still pack
through the unified `tronhawk pack` command and the same-version Rust/SHA
path — never invoke the engine binary directly.

Alternative (contributors inside a TronHawk monorepo checkout, from the repo
root only):

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> <out.thx>
```

The runtime still only loads executable CommonJS
(`module.exports.activate`/`deactivate`) — TypeScript ESM (`export default`)
is never executed directly, so `entry.renderer` / `entry.main` must point at
`.js` (see `docs/PLUGIN-SDK.md`).

Do NOT depend on Electron private APIs, Chromium internals, or target-app implementation details.

## Lifecycle contract (binding)

- `activate` / `deactivate` may return `undefined` synchronously **or a Promise** — the runtime drains a returned Promise before the plugin counts as activated/deactivated.
- Event and window callbacks (`onLoad`, `onRendererReady`, `onUnload`, `window.onCreated`, `dom.observe`) must be **synchronous and return `undefined`**. A callback that throws, exceeds its CPU deadline, or returns a non-`undefined` value is unregistered and never re-invoked.

## Sandbox limits

Plugin code runs in embedded QuickJS: no DOM, network, Node, or Electron access by default. Every evaluation and host-invoked callback has a one-second CPU deadline plus memory/stack limits; abusing plugins are hard-disabled. Every privileged API checks the plugin's declared `manifest.json` permissions first. CSS is data (`insertCSS`), never executed as JS; there is no arbitrary page-JS bridge. Developer mode (`runtime.unsafe`, off by default) is the deliberate exception and is never sandboxed.

## Permissions (implemented)

| Permission | API |
|---|---|
| `renderer.css` | `ctx.css.insert/remove`, manifest `css` data |
| `renderer.script` | `ctx.script.setDocumentTitle` |
| `renderer.dom` | `ctx.dom.query/observe` |
| `renderer.storage` | `ctx.storage.get/set` (renderer-only) |
| `electron.window` | `ctx.window.*`, `onLoad/onRendererReady/onUnload` |
| `network.access` | `ctx.network.request` (Core-side whitelisted fetch) |
| `runtime.unsafe` | `ctx.raw` (developer mode only) |

`electron.webContents` (DevTools/reload aside), `electron.session`, `electron.ipc`, and `network.proxy` are future — do not build on them yet.

## Manifest

The `tronhawk` field (e.g. `"^0.1"`) is the host runtime protocol version, NOT this SDK's npm version:

```json
{
  "id": "com.example.dark-theme",
  "name": "Dark Theme",
  "version": "1.0.0",
  "author": "Example",
  "tronhawk": "^0.1",
  "entry": { "css": "theme.css" },
  "permissions": ["renderer.css"]
}
```

## Links

- Full API contract: `docs/PLUGIN-SDK.md` in the TronHawk repo
- Scaffolder: `tools/create-tronhawk-plugin`
- Examples: `plugins/` (`glass-window`, `ui-tweaks`, `devtools-f12`)

## License

Apache-2.0. See `LICENSE` in the TronHawk repo.

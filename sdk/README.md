# @tronhawk/sdk

TypeScript API for [TronHawk](https://github.com/Zhanyuanium/TronHawk) plugins. Types only — no runtime.

> Version `0.1.0` is the first usable but incomplete release. Only the APIs listed below as implemented are wired into the host runtime. The authoritative contract lives in `docs/PLUGIN-SDK.md` in the TronHawk repo.
>
> 中文版见 [README.zh-CN.md](./README.zh-CN.md)。

## Install

```sh
bun add @tronhawk/sdk
```

Requires `bun` (the repo's JS toolchain). No runtime dependencies.

## Quick start

Scaffold a plugin (from the TronHawk monorepo):

```sh
bun run create-tronhawk-plugin -- plugins/my-plugin --type renderer
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

## What the SDK provides

- `PluginContext`: `logger`, `network` (domain-whitelisted, `network.access`), `config` (read via Manager snapshot; `set` is a no-op for sandboxed plugins).
- `RendererContext`: `css.insert/remove` (`renderer.css`), `script.setDocumentTitle` (`renderer.script`), `dom.query/observe` (`renderer.dom`, serialized snapshots, ~100 ms polling), `storage.get/set` (`renderer.storage`, renderer-only, host-namespaced per plugin).
- `MainContext`: `window.onCreated/setOpacity/setSize/setPosition/setVibrancy/setMica` (`electron.window`), `onLoad/onRendererReady/onUnload` lifecycle events (main-root, synchronous `undefined` callbacks, fail-closed unregister).
- Test helpers: `createMockRendererContext`, `createMockMainContext`, `createLogger`, `injectCSS`.

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
- Examples: `plugins/` (`hello-world`, `dark-script`, `glass-window`, `ui-tweaks`, `window-effects`)

## License

Apache-2.0. See `LICENSE` in the TronHawk repo.

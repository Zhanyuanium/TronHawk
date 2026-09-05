# @tronhawk/sdk

[TronHawk](https://github.com/Zhanyuanium/TronHawk) 插件的 TypeScript API。纯类型，无运行时。

> `0.1.0` 是首个可用但不完整的版本。只有下面标注“已实现”的 API 才真正接入了宿主运行时。权威契约见仓库内 `docs/PLUGIN-SDK.md`。
>
> English version: [README.md](./README.md).

## 安装

```sh
bun add @tronhawk/sdk
```

需要 `bun`（仓库统一 JS 工具链）。无运行时依赖。

## 快速开始

从 TronHawk monorepo 脚手架建插件：

```sh
bun run create-tronhawk-plugin -- plugins/my-plugin --type renderer
# --type css | renderer（默认）| main
```

或在已有插件里引用（只引类型）：

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

主进程插件：

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

## SDK 提供的内容

- `PluginContext`：`logger`；`network`（需 `network.access`，Core 侧域名白名单 fetch）；`config`（读 Manager 下发的快照，沙盒插件的 `set` 是 no-op）。
- `RendererContext`：`css.insert/remove`（`renderer.css`）；`script.setDocumentTitle`（`renderer.script`）；`dom.query/observe`（`renderer.dom`，序列化快照、约 100ms 轮询）；`storage.get/set`（`renderer.storage`，仅 renderer、按插件隔离）。
- `MainContext`：`window.onCreated/setOpacity/setSize/setPosition/setVibrancy/setMica`（`electron.window`）；`onLoad/onRendererReady/onUnload` 生命周期事件（挂在 main 根上，同步 `undefined` 回调，失败即注销）。
- 测试辅助：`createMockRendererContext`、`createMockMainContext`、`createLogger`、`injectCSS`。

不要依赖 Electron 私有 API、Chromium 内部实现或目标 App 的实现细节。

## 生命周期契约（强制）

- `activate` / `deactivate` 可同步返回 `undefined`，也可返回 `Promise`——返回 Promise 时 runtime 会 drain 完才算激活/停用完成。
- 事件与窗口回调（`onLoad`、`onRendererReady`、`onUnload`、`window.onCreated`、`dom.observe`）必须同步返回 `undefined`。throw、超 CPU 时限或返回非 `undefined` 的回调会被注销，不再触发。

## 沙盒限制

插件跑在内嵌 QuickJS：默认无 DOM、无网络、无 Node、无 Electron。每次求值与回调有 1 秒 CPU 时限 + 内存/栈限制，超预算会被硬禁用。每次特权调用先查 `manifest.json` 声明的权限。CSS 按数据经 `insertCSS` 注入，不会当 JS 执行；没有任意页面 JS 桥。Developer mode（`runtime.unsafe`，默认关闭）是刻意的例外，不受沙盒保护。

## 权限（已实现）

| 权限 | API |
|---|---|
| `renderer.css` | `ctx.css.insert/remove`、manifest `css` 数据 |
| `renderer.script` | `ctx.script.setDocumentTitle` |
| `renderer.dom` | `ctx.dom.query/observe` |
| `renderer.storage` | `ctx.storage.get/set`（仅 renderer） |
| `electron.window` | `ctx.window.*`、`onLoad/onRendererReady/onUnload` |
| `network.access` | `ctx.network.request`（Core 侧白名单 fetch） |
| `runtime.unsafe` | `ctx.raw`（仅 developer mode） |

`electron.webContents`（除 DevTools/reload 外）、`electron.session`、`electron.ipc`、`network.proxy` 还是 future，先不要基于它们开发。

## Manifest

`tronhawk` 字段（如 `"^0.1"`）是宿主 runtime 协议版本，不是本 SDK 的 npm 版本：

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

## 链接

- 完整 API 契约：仓库 `docs/PLUGIN-SDK.md`
- 脚手架：`tools/create-tronhawk-plugin`
- 示例：`plugins/`（`hello-world`、`dark-script`、`glass-window`、`ui-tweaks`、`window-effects`）

## License

Apache-2.0，见仓库 `LICENSE`。

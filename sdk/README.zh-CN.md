# @tronhawk/sdk

[TronHawk](https://github.com/Zhanyuanium/TronHawk) 插件的 TypeScript API：上下文类型 + 测试辅助。无宿主运行时，无打包器。

> `0.2.0` 是首个可用但不完整的版本。只有下面标注“已实现”的 API 才真正接入了宿主运行时。权威契约见仓库内 `docs/PLUGIN-SDK.md`。
>
> English version: [README.md](./README.md).

## 安装

```sh
bun add @tronhawk/sdk
```

需要 `bun`（仓库统一 JS 工具链）。无运行时依赖。

## 快速开始

独立脚手架建插件（无需 TronHawk checkout，在任何目录都可用）：

```sh
create-tronhawk-plugin plugins/my-plugin --type renderer
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

> 上面是用于类型检查的 TypeScript 源码。宿主实际加载的文件（`entry.renderer` / `entry.main`）必须是可执行的 CommonJS（`module.exports = { activate, deactivate }`）——ESM（`export default`）永远不会被直接执行。脚手架生成的 `src/renderer.js` / `src/main.js` 就是这种形式。

## SDK 提供的内容

- `PluginContext`：`logger`；`network`（需 `network.access`，Core 侧域名白名单 fetch）；`config`（读 Manager 下发的快照，沙盒插件的 `set` 是 no-op）。
- `RendererContext`：`css.insert/remove`（`renderer.css`）；`script.setDocumentTitle`（`renderer.script`）；`dom.query/observe`（`renderer.dom`，序列化快照、500ms 轮询）；`storage.get/set`（`renderer.storage`，仅 renderer、按插件隔离）。
- `MainContext`：`window.onCreated/setOpacity/setSize/setPosition/setVibrancy/setMica`（`electron.window`）；`onLoad/onRendererReady/onUnload` 生命周期事件（挂在 main 根上，同步 `undefined` 回调，失败即注销）。
- 测试辅助（无需宿主即可用）：`createMockRendererContext`、`createMockMainContext`、`createLogger`、`injectCSS`。可在 TronHawk 宿主之外做单元测试。

SDK 不提供的东西：没有宿主运行时（没有 QuickJS 沙箱，除 mock 外不提供任何 `ctx` 实现），也没有 `.thx` 打包器。打包由同版本原生 `tronhawk-pack` 引擎判定，经独立 `@tronhawk/cli`（`tronhawk` 二进制）调用。

独立工具链（无需 TronHawk checkout）：

```sh
create-tronhawk-plugin my-plugin --type renderer
cd my-plugin && bun install
bun run build              # tronhawk build .：打包 entry 到 dist/（CSS-only 无 build 步骤，style.css 按数据发布）
bun test                   # 基于 SDK mock 的起始冒烟测试（无需宿主）
./node_modules/.bin/tronhawk test . --sandbox  # QuickJS 契约 harness（随 CLI 发布，无需 checkout）
./node_modules/.bin/tronhawk validate .        # 权威目录检查（不写文件）
bun run pack               # tronhawk pack . my-plugin.thx（或 ./node_modules/.bin/tronhawk pack . my-plugin.thx）
./node_modules/.bin/tronhawk inspect my-plugin.thx
```

如何调用 `tronhawk`：`tronhawk` 只是 devDependency 的 bin（`node_modules/.bin/tronhawk[.exe]`），不在 `PATH` 上，插件目录里裸打 `tronhawk validate .` 会报找不到命令——`bun run <script>` 会自动解析 `.bin`，裸命令不会。三选一：(1) `./node_modules/.bin/tronhawk …`（最稳，上面的可复制命令就是这种）；(2) 本窗口临时把 `.bin` 加进 `PATH`（仅当前 shell 生效）；(3) 写进 `package.json` 的 `scripts` 走 `bun run`（反复用推荐，`build`/`pack` 本来就是这样）。常用命令建议都写成 npm scripts，例如 `{ "scripts": { "validate": "tronhawk validate .", "sandbox": "tronhawk test . --sandbox" } }`，然后 `bun run validate` / `bun run sandbox`。详见 `tools/tronhawk-cli/README.md` 的 How to invoke `tronhawk` 一节。

CLI 只从可信来源解析引擎（不做 PATH 搜索），优先级从高到低：`TRONHAWK_PACK_BIN`（显式指定，优先级最高）、显式配置 `tronhawk.packBin`，或本地 cargo 构建产物 `target/{release,debug}/tronhawk-pack(.exe)`。把 `TRONHAWK_PACK_BIN` 指向同版本 `tronhawk-pack` 发布二进制——CLI 的 `tronhawk.engineVersion` 必须与 `tronhawk-pack --version` 严格一致；缺失、digest 不一致或版本不一致都会 hard-fail 并给出安装指引（没有 TypeScript 兜底打包器）。CSS-only 插件显式跳过 `build`，但仍走统一 `tronhawk pack` 命令与同版本 Rust/SHA 路径——永远不要直接调用引擎二进制。

备选（仅限 TronHawk monorepo checkout 内的贡献者流程，从仓库根目录执行）：

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> <out.thx>
```

运行时只加载可执行的 CommonJS（`module.exports.activate`/`deactivate`）——TypeScript ESM（`export default`）永远不会被直接执行，所以 `entry.renderer` / `entry.main` 必须指向 `.js`（见 `docs/PLUGIN-SDK.md`）。

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

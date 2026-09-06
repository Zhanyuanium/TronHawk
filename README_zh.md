# TronHawk

**Electron 应用的运行时扩展平台**。TronHawk 可以在运行时向第三方 Electron
应用注入插件——CSS 主题、渲染进程微调、主进程窗口/Electron 扩展——**且不改动
目标应用磁盘上的任何一个字节**。

目标应用的可执行文件、`app.asar`、打包资源、Electron 和 Chromium 永远不会被
改动（纯运行时原则，见 `docs/SPEC.md` §1）。扩展由用户控制，受权限门控，
运行在沙箱中。

> 状态：预发布版本（`0.1`）。Phase 0–4 已完成；Phase 5（开源准备）进行中。
> MVP 范围是 **Windows x64**。见 [状态](#状态)。
>
> English version: [README.md](./README.md).

## 亮点

- **非侵入**：通过 electron-hook（Detours）做内存 ASAR 重映射 + DLL 注入。
  不 patch 二进制，不重写文件，不替换 Chromium。
- **沙箱化插件**：插件 JS 运行在内嵌的 QuickJS 引擎中，默认**没有 DOM、
  网络、Node 或 Electron 访问能力**。每次求值和每次宿主回调都有**一秒 CPU
  时限**，另有内存/栈上限；超出累计预算的插件会被硬禁用。
- **异步宿主 API**：`ctx.dom.query`/`observe`（序列化快照）、
  `ctx.network.request`（Core 侧域名白名单 fetch）、`ctx.storage`、
  `ctx.config`，以及运行时的 `ctx.css.insert`/`remove`，都是经由同步
  QuickJS VM 泵驱动的真正 Promise；`activate`/`deactivate` 也可以是异步的
  （ADR 0008）。没有 `network.access` 授权时，`ctx.network` 是一个调用即返回
  可捕获错误的拒绝桩。
- **权限门控**：每个特权 API 都会先检查插件声明的权限（`renderer.css`、
  `renderer.script`、`renderer.dom`、`renderer.storage`、`electron.window`、
  `network.access` 等）。CSS 被当作**数据**对待，永远不会作为 JS 执行；不存
  在任意页面 JS 执行桥，插件也不能直接 `fetch()`。
- **分层架构**：Manager、Core、Injector、Runtime 严格分离（`docs/AGENTS.md`）。

## 工作原理

```
Manager（Tauri 图形界面）──► Core 守护进程（Rust）   本地 socket 上的 JSON-RPC
                                    │
                                    ▼
目标 Electron 应用 ◄── 注入器（tronhawk_injector.dll，electron-hook）
       │   主进程：Runtime 启动，在 QuickJS 中执行插件
       └── 渲染进程：纯数据 CSS + 少量宿主原生页面 API
```

1. 在 **Manager** 里注册目标 Electron 应用，安装/启用插件（连同其权限）。
2. 启动目标应用时会经过**注入器**（透明的启动器包装 / IFEO 注册），经由
   electron-hook 把 `tronhawk_injector.dll` 载入目标的主进程。
3. 目标内的**运行时**连回 **Core** 守护进程，拿到执行计划（启用了哪些插件、
   授予了哪些权限），在 QuickJS 沙箱里运行渲染进程插件和主进程插件。
4. 渲染进程 CSS 以数据形式注入每个窗口；渲染进程 JS 只能调用少量的宿主原生
   操作；主进程插件通过 TronHawk 上下文获得窗口 API——永远接触不到原生
   Electron。

对走不通透明启动路径的应用，有备用的 "launch with extensions"（带扩展启动）
流程。

## 支持的 Electron 应用

支持是**分级的**，不是非黑即白（`docs/SPEC.md` §5）：

| 等级 | 能力 |
|---|---|
| 0 | **不支持** —— 加固/ASAR 完整性校验目标、DRM/反作弊/银行软件。不提供扩展支持，不做保证。 |
| 1 | **渲染进程扩展** —— 纯数据 CSS 注入（+ 运行时 `css.insert`/`remove`）、经 QuickJS 沙箱的渲染进程 JS、DOM 查询/观察（序列化快照）。 |
| 2 | **Electron 扩展** —— 经 TronHawk API 操作 BrowserWindow（`window`、生命周期事件、vibrancy/Mica）；webContents / session / IPC 是未来工作。 |

目标包括主流 Electron 应用（如 ChatGPT Desktop、Obsidian、Discord）。兼容性
按应用逐个验证——见 `docs/BACKLOG.md` 的真机结论和 `docs/SPEC.md` §8（已验
证：标准 Electron 43.4.1 应用；Obsidian 注入 + 渲染进程 CSS/DOM，2026-09 的
实际运行中完整工作区正常渲染；VS Code / ChatGPT-MSIX 变体受应用包布局所限
——已跟踪）。

## 仓库结构

```
crates/            Rust workspace
  core/            Core 守护进程：生命周期、插件解析、权限检查、IPC、存储
  injector/        注入器 cdylib + 启动器包装（封装 vendor 的 electron-hook）
  runtime/         插件执行引擎 + QuickJS 沙箱（JS 桥：crates/runtime/js）
  ipc/             JSON-RPC 传输（带版本、结构化错误）
  package/         .thx（ZIP）包机制 —— 打包/解包 + manifest 校验
apps/
  manager/         Tauri 图形界面：应用、插件、权限、日志
  test-app/        确定性 Electron 夹具应用，用于开发 + 集成测试
sdk/               @tronhawk/sdk —— TypeScript 插件 API
plugins/           示例插件（hello-world、dark-script、glass-window、ui-tweaks、window-effects）
tools/             create-tronhawk-plugin 脚手架
vendor/            第三方源码 vendor（electron-hook + Detours）
docs/              SPEC、AGENTS、PLAN、BACKLOG、PLUGIN-SDK、PLUGIN-REGISTRY、adr/
tests/             集成测试（pwsh tests/integration.ps1）
```

## 快速开始

> 独立插件开发首选 standalone 工具链：`@tronhawk/sdk` 的类型 + 测试辅助，配合独立
> `@tronhawk/cli`（`tronhawk` 二进制）与同版本 `tronhawk-pack` 引擎——不需要 TronHawk
> checkout（见 `docs/PLUGIN-SDK.md` 与 `tools/create-tronhawk-plugin/README.md`）。下面的
> 构建/测试/打包命令是在本 monorepo 里开发 TronHawk 本体用的；`cargo run -p` 的 monorepo
> 打包流程仅是贡献者备选（只能在仓库根目录下运行）。

### 前置条件

- Windows 10/11 x64（MVP 平台），装好 MSVC C++ 构建工具
- [Rust](https://rustup.rs) stable（MSVC host）
- [bun](https://bun.sh) ≥ 1.4 —— 仓库统一 JS 工具链（不需要 Node）
- WebView2 运行时（Tauri Manager 需要）
- PowerShell 7+（`pwsh`，跑集成测试用）

### 构建 Rust workspace

```sh
bun install          # 链接 JS workspaces（sdk、plugins/*、tools/*）
cargo build --workspace
```

构建运行时 JS 包（新克隆后跑一次即可 ——
`crates/runtime/assets/runtime.js` 是 gitignored 的构建产物）：

```sh
cd crates/runtime/js && bun install && bun run build
```

### 跑测试

```sh
cargo test --workspace                # Rust 单元测试

cd sdk && bun test && bun run typecheck   # SDK 测试 + 类型检查
cd plugins/hello-world && bun run typecheck

pwsh tests/integration.ps1            # 端到端：经注入器启动 test-app
```

### 试用 SDK 和示例插件

```sh
cd sdk && bun install && bun test
cd plugins/hello-world                # 看 manifest.json + src/ 了解插件形状
```

### 跑 Manager（Tauri 图形界面）

```sh
cd apps/manager
bun install
bun run tauri dev
```

打出应用包（先 stage Core sidecar）：

```sh
cd apps/manager && bun run bundle
```

### 跑确定性测试应用（Electron）

```sh
cd apps/test-app
bun install
bun start
```

`apps/test-app` 是插件开发和集成验证用的确定性 Electron 夹具：固定的
`BrowserWindow`、渲染进程 UI、一条 IPC 通道、一个 session、动态添加的 DOM。

## 创建插件

用 `create-tronhawk-plugin` CLI（仓库根目录）搭插件工程：

```sh
bun run create-tronhawk-plugin -- plugins/foo --type renderer
# css | renderer（默认）| main  → 见 tools/create-tronhawk-plugin/README.md
```

`plugins/foo` 里会有 `manifest.json`（id、name、version、author、
`tronhawk: "^0.1"` 运行时协议范围、`entry`、`permissions`）、TypeScript
 starter 和给主题用的 `style.css`。manifest 声明插件需要的权限；Manager 会
展示它们，由用户授权。完整插件 API 契约见 `docs/PLUGIN-SDK.md`。

用 Rust 打包器把插件打成 `.thx`（ZIP）：

```sh
cargo run -p tronhawk-package --bin pack -- plugins/foo foo.thx
```

**插件注册表元数据格式**——未来插件商店列出插件、Manager 对下载的包做元数
据校验所用的目录契约——定义在 `docs/PLUGIN-REGISTRY.md`。格式先行；商店浏览
和安装时完整性交叉检查是未来工作，Manager 里还没接线。

## 安全模型

- **插件不可信。** 插件跑在内嵌 QuickJS 沙箱里——没有 `document`、
  `fetch`、`require`、`process`；没有 `runtime.unsafe`（开发者模式，一种按
  应用 opt-in 的例外，见 `SECURITY.md`），永远接触不到原始文件系统、进程
  执行和原生 Electron/Node。
- **权限门控。** 每个特权 API 先检查插件声明的权限（权限表见
  `docs/PLUGIN-SDK.md`）。安装时不执行包内代码；`.thx` 的 manifest 会被校验，
  解包防 Zip Slip 且有归档限制。注册表条目字节应在安装时与下载的包做交叉
  检查——那是已规划的契约，Manager 里还没接线。
- **CPU 上限。** 每次求值/回调一秒时限，内存和栈上限，外加累计预算的中断上
  限，作恶插件会在当前计划代内被硬禁用。
- **无任意页面 JS。** CSS 是经 `insertCSS` 注入的数据；渲染进程脚本只限宿主
  原生操作（如经固定赋值模板的 `setDocumentTitle`）。完整 rationale 见
  `docs/adr/0002-renderer-js-sandbox.md`。
- **无原始网络。** 插件开不了 socket，也不能直接 `fetch()`；
  `ctx.network.request()` 跑在 Core 侧，经过权限检查、域名白名单和审计日志。

威胁模型、受支持应用边界、漏洞上报方式见 `SECURITY.md`。

## 状态

| 阶段 | 交付 | 状态 |
|---|---|---|
| 0 | 地基：Rust workspace、Tauri 壳、SDK、测试应用 | 完成 |
| 1 | 注入：vendor 的 electron-hook、启动器/IFEO 激活、通信 | 完成（标准 Electron 43.4.1 上已验证） |
| 2 | 渲染进程插件：`.thx` 打包、纯数据 CSS、热重载 | 完成 |
| 3 | QuickJS 沙箱 + 主进程插件：窗口 API、权限、CPU 时限 | 完成 |
| 4 | Manager 界面：应用/插件/权限/日志 | 完成 |
| 5 | **开源准备：公开文档、许可证/合规、贡献指南** | 进行中 |

已实现 API 与未来工作的分界写在 `docs/PLUGIN-SDK.md` 开头；剩余跟进项
（webContents/session/IPC、`network.proxy`、`.thx` 签名校验、实时日志推送/
导出、真机应用画像）跟踪在 `docs/BACKLOG.md`。

## 文档索引

| 文档 | 内容 |
|---|---|
| `README.md` | 本 README 的英文版 |
| `docs/SPEC.md` | 产品与架构 spec（需求、分级、决策） |
| `docs/AGENTS.md` | AI/贡献者开发规则与模块边界（具约束力） |
| `docs/PLAN.md` | 分阶段执行路线图 |
| `docs/BACKLOG.md` | 开放跟进项、韧性说明、真机验证结论 |
| `docs/PLUGIN-SDK.md` | 插件 API 契约（上下文、权限、生命周期） |
| `docs/PLUGIN-REGISTRY.md` | 插件注册表元数据格式 |
| `docs/adr/` | 架构决策记录（注入后端、渲染进程 JS 沙箱） |
| `THIRD_PARTY_NOTICES.md` | 第三方许可证合规包 |
| `CONTRIBUTING.md` | 构建/测试/开发流程、提交规范 |
| `SECURITY.md` | 威胁模型与漏洞上报 |

## 许可证

TronHawk 按组件**双轨授权**：

- TronHawk **原创代码**采用 **Apache License, Version 2.0** —— 见 `LICENSE`。
  不覆盖第三方组件。
- 分发的 `tronhawk_injector.dll` **静态链接了 electron-hook 0.2.2
  （LGPL-3.0）**，因此是 **LGPL-3.0 组合作品**，不适用动态链接豁免。
  LGPL-3.0 §4(b) 要求的 GNU GPL-3.0 文本在 `LICENSE.GPL-3.0`；LGPL-3.0 文本
  在 `vendor/electron-hook/LICENSE`。

完整合规包（声明、最小对应源码 = `vendor/electron-hook/`、对应应用代码 =
`crates/injector/` + 根 `Cargo.toml`/`Cargo.lock`、重链接/构建说明）见
`THIRD_PARTY_NOTICES.md`，来源说明见 `NOTICE`。

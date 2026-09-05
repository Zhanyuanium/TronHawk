# ADR 0009 — WCO 消除的构造期介入点：主进程 `Module._load` 拦截 + electron Proxy 门面

Status: **Accepted** (2026-09-05)

## Context

部分 Electron 应用（VS Code、WorkBuddy，以及任何自绘标题栏应用）在 Windows 上用
`titleBarStyle: "hidden"` + `titleBarOverlay: {...}` 创建主窗口（即 Window Controls
Overlay，下称 WCO），由 OS/Chromium 在最右上绘制原生 min/max/close 按钮。该按钮区域对
DOM 是禁区，renderer CSS/JS 无法改样式或隐藏。

TronHawk 的目标：消除这些原生 WCO 按钮，但不做任何自绘标题栏控件，且遵循 runtime-only
原则（绝不修改目标 app 磁盘文件）。

### 已核实的事实（权威）

1. `frame?`、`titleBarStyle?`、`titleBarOverlay?`、`trafficLightPosition?` 均为
   `new BrowserWindow(options)` **构造选项**，构造期定死。Electron 没有运行期
   `setFrame` / `setTitleBarStyle`。
2. 运行期可调用的仅有：`setTitleBarOverlay(options)`（Windows/Linux，只能改
   color/symbolColor/height，不能移除按钮）；`setWindowButtonPosition` /
   `setWindowButtonVisibility`（**macOS only**，Windows 无效）。
3. **实测**：`require("electron").BrowserWindow` 在主进程是 `configurable:false` +
   **getter-only（无 setter）** 的访问器属性。对其赋值在 sloppy mode 下静默 no-op、
   不抛错。因此"运行时替换 `require("electron").BrowserWindow` 导出"这条路不可行。
4. TronHawk runtime 已在 target 主进程内运行（bootstrap.js 于 `require(originalAsar)`
   之前先 `runtime.start(app)`），即 runtime 在 target 创建任何窗口之前已就绪。
5. `onWindowOptions` / `applyWindowOptions` / `wco` adapter 逻辑正确（单测通过），但
   接到"替换 electron BrowserWindow 导出"这一步在真实 Electron 上失败（事实 3）。

## Decision

**不在 electron 导出对象上替换属性（事实 3 封死），而是在 target 代码"拿到 electron
模块"之前拦一道——wrap Node 的 `require("module")._load`，当请求 `'electron'` 时返回
一个 Proxy 门面；门面上仅 `BrowserWindow` 属性 getter 被替换为"先过
`adapter.onWindowOptions`、再调用真实构造器"的包装构造器，其余属性全部转发到真实
electron exports。**

一句话：**构造期在模块解析层改写窗口选项，是消除 WCO 唯一合规且可验证的路径。**

### 为何绕过事实 3

- WCO 是构造期决定物（事实 1）。只要在真实构造器执行之前改掉 `opts`，就不会有任何
  原生按钮被创建。
- 介入点选在 Node 模块加载层，而非 electron 导出对象。`Module._load` 是 Node `module`
  模块上的普通可写函数属性（pirates / proxyquire 的公认 seam），Electron 主进程内同样
  可写——Electron 主进程的 `require('electron')` 也走 `Module._load` 的内置模块分支。
- Proxy 门面只拦截一个属性：`get` trap 对 `"BrowserWindow"` 返回包装构造器，其余
  `get`/`set`/`has`/`ownKeys`/`getPrototypeOf`/`getOwnPropertyDescriptor` 全委托到真实
  electron exports。于是：
  - `const { BrowserWindow } = require("electron")`（解构）与
    `require("electron").BrowserWindow`（属性读）都拿到包装构造器；
  - `electron.app`/`electron.protocol`/`ipcMain` 等身份不变（转发同一真实对象）；
  - `electron.BrowserWindow = x` 语义与基线一致（`set` trap 转发到真实对象上同一个
    不可配置 accessor：sloppy 静默、strict 抛 TypeError）——不改变 target 可观察行为；
  - 门面按进程缓存一次，`require("electron") === require("electron")` 恒成立。

### 时序

`bootstrap.js:311` 先 `runtime.start(app)`（内含 adapter 选择与 seam 安装），**之后**才
`require(originalAsar)` 加载 target 入口。故 target 主进程里任何模块此后第一次
`require("electron")` 必穿过被 wrap 的 `_load`，无"target 先拿到真实 electron"的窗口期。

### 与候选方案对比

| 方案 | 裁决 |
|---|---|
| A：`app.on('browser-window-created')` | Windows 上彻底无路（构造后无 API 能移除 WCO 按钮；Win32 剥 `WS_CAPTION` 属 forbidden native hook 且为 undocumented hack）。**否决作为消除手段**，仅作未来 WCO-restyle 落点。 |
| B-asar：改写 target 入口 / wrapper module | bootstrap 已在做入口包装（ENTRY_TEMPLATE）；再改写 target 其它 JS 触碰"Injector 无插件逻辑"边界，且对无 app.asar 的 VS Code 不适用。**否决**。 |
| `BrowserWindow.prototype` patch | 构造选项已被 native 构造器消费，改原型无效。**否决**。 |
| C：接受现实 | 仅作 fail-open 降级分支（门面安装失败时退化为"仅变色/改高"），**不作默认结论**。 |
| **B 变体：`Module._load` 门面** | **采纳**。 |

## Consequences / layering

- **归属 Runtime 层**（`crates/runtime/js/src/`），落点 `index.js` 的 `start()` adapter
  缝内；建议抽成独立小模块 `crates/runtime/js/src/electron-require-shim.js`。
- 符合 AGENTS.md 边界：Runtime "bridge to Electron" ✅；Injector 零改动（无 asar 改写，
  与 merged-asar/`.unpacked` 兼容风险为零）✅；bootstrap 只建 IPC 传输 ✅；`wco` adapter
  仍为 core-owned static 捆绑（非 .thx、非磁盘可发现）✅；纯内存、不改目标磁盘 ✅。
- **边界澄清**：`Module._load` 是 Node 模块系统的扩展点（带下划线但属 pirates/proxyquire
  公认语义），不是 Electron 私有符号、不属于 forbidden 的 "native hooks / undocumented
  Electron hacks"。批准范围严格限定：**仅拦截 `'electron'` 这一个内置模块请求，且仅在
  选定 adapter 声明 `onWindowOptions` 时安装**。

## Risks / follow-ups

1. **低概率绕过面**：`process.getBuiltinModule("electron")`（Node ≥22）与 ESM
   `import("electron")` 可能不经过 `Module._load` 常规路径。target 主进程为 CJS，实际风险
   低；可在 shim 内加构造计数并与 `app.on("browser-window-created")` 计数比对，不一致时打
   `warn`（"某些窗口构造绕过了 WCO seam"），把静默失效变成可观测。
2. **门面语义泄漏**：`Object.getOwnPropertyDescriptor(require("electron"), "BrowserWindow")`
   会拿到真实构造器的描述符（`getOwnPropertyDescriptor` trap 委托）。极罕见，可接受。
3. **幂等/重入**：同一进程内 `start()` 不应二次 wrap；shim 需自检（检查 `_load` 是否已被
   自身标记包裹）。
4. **Electron 版本漂移**：未来若 `Module._load` 对内置模块处理变化，fail-open 保证 target
   不崩，退化为 C 的 restyle 模式。

## 独立遗留 gate（不属本决策）

**VS Code unpacked 注入入口**：`vendor/electron-hook` 只 hook 含 `resources\app.asar`
（或 `_app.asar`）子串的路径；VS Code 是 unpacked `resources/app/`、**无 app.asar**，
launcher 的 minimal-stub fallback 对它是空转——当前 VS Code 根本没有 bootstrap 进入主进程
的通道。这是 **Injector 层课题，先于 WCO 课题**。`Module._load` 门面本身与 asar 布局无关
（只要 bootstrap 进了 VS Code 主进程且在 `out/main.js` 之前运行即生效），但该前提尚未
满足。按 ADR 0006（QQNT）模式单独立 feasibility ADR / gate，不在本决策内展开。本次
WCO 消除以 `apps/test-app`（本就是 WCO 验证宿主）端到端验证。

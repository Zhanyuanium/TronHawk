# DevTools F12

开发者模式主进程插件：在目标应用的窗口聚焦时按 **F12**，为该窗口
开关 DevTools。

- 机制：仅对每个窗口的 `webContents` 监听 `before-input-event`，
  刻意不注册系统级全局快捷键。
- 只有无修饰键的 F12 `keyDown` 才响应（修饰键与连击被忽略，
  事件经 `preventDefault` 消费）。
- 禁用插件（或收回授权）会移除全部监听器；已关闭窗口的记录会经
  `destroyed` 事件及时释放，不会堆积。

## 安装与授权

1. 打包并安装插件：
   ```sh
   cargo run -p tronhawk-package --bin tronhawk-pack -- pack plugins/devtools-f12 devtools-f12.thx
   ```
   再用该 `.thx` 路径调用 `installPlugin`。
2. 目标应用必须注册为 **support level 2**。
3. 打开 **developer mode**（Manager 设置页），再对该应用启用插件并授予
   **`runtime.unsafe`**（其唯一权限）。
4. 聚焦目标应用的任意窗口，按 F12。

## 运维注意

- 重装同一插件（`installPlugin`）会把该插件在**所有应用**的策略重置为
  默认值（禁用、无授权）：之后必须重新启用并重新授权，否则插件会静默停跑。
- 关闭 developer mode 会 **purge 掉所有 `runtime.unsafe` 授权**；重新打开
  不会自动恢复，必须按应用重新授权。
- 经 Core `queryLogs` 诊断：出现 `devtools-f12 activated (windows watched: N)`
  表示插件已进入执行计划并存活；完全没有激活日志表示它根本没进入计划——
  检查插件是否启用、应用是否为 level 2、developer mode 是否打开、
  `runtime.unsafe` 有效授权是否存在（缺授权时 main payload 在进计划前就被
  拿掉，插件不会运行）。

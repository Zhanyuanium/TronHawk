# DevTools F12

Developer-mode main plugin: pressing **F12** while a window of the target app
is focused toggles DevTools for that window.

- Mechanism: per-window `webContents` `before-input-event` listeners only.
  There is deliberately no system-global shortcut.
- Only a bare F12 `keyDown` counts (modifiers and auto-repeat are ignored,
  and the event is consumed via `preventDefault`).
- Disabling the plugin (or revoking its grant) removes every listener.

## Install and authorize

1. Pack and install the plugin:
   ```sh
   cargo run -p tronhawk-package --bin tronhawk-pack -- pack plugins/devtools-f12 devtools-f12.thx
   ```
   then `installPlugin` with that `.thx` path.
2. The target application must be registered at **support level 2**.
3. Turn **developer mode** on (Manager Settings), then enable the plugin for
   that application and grant it **`runtime.unsafe`** (its only permission).
4. Focus any window of the target app and press F12.

## Operational gotchas

- Re-installing the same plugin (`installPlugin`) **resets its per-application
  policy to the default** (disabled, no grants): re-enable and re-grant
  afterwards, otherwise the plugin silently stops running.
- Turning developer mode **off purges every `runtime.unsafe` grant**; turning
  it back on does not restore them — grant again per application.
- Diagnose via Core `queryLogs`: `devtools-f12 activated (windows watched: N)`
  means the plugin is live; `ctx.raw absent` means developer mode or the
  `runtime.unsafe` grant is missing.

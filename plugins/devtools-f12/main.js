// DevTools F12 — developer-mode main plugin: F12 toggles DevTools on the
// focused window, via two complementary paths:
//
//  1. globalShortcut F12 (system-wide) — registered only after app ready.
//  2. per-window webContents `before-input-event` for F12 keyDown — works when
//     the app window is focused even if the global accelerator is taken.
//
// Requires developer mode + the `runtime.unsafe` grant: `ctx.raw.electron` is
// the real Electron module of the injected app (see docs/PLUGIN-SDK.md §ctx.raw
// and ADR 0007). Without the grant this plugin logs a warning and does nothing.
var state = { registered: false, fallbackWindows: [] };

function getElectron(ctx) {
  if (ctx && ctx.raw && ctx.raw.electron) {
    return ctx.raw.electron;
  }
  return null;
}

function toggleDevTools(BrowserWindow, logger) {
  try {
    var win = BrowserWindow.getFocusedWindow();
    if (win && win.webContents) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools();
      }
    }
  } catch (err) {
    try {
      logger.warn("devtools-f12 toggle failed: " + (err && err.message ? err.message : err));
    } catch (ignored) {}
  }
}

function attachWindowFallback(electron, logger) {
  try {
    var app = electron.app;
    var BrowserWindow = electron.BrowserWindow;
    if (!app || !BrowserWindow) {
      return;
    }
    var attach = function (win) {
      try {
        if (!win || !win.webContents) {
          return;
        }
        win.webContents.on("before-input-event", function (event, input) {
          try {
            if (input && input.type === "keyDown" && (input.key === "F12" || input.code === "F12")) {
              toggleDevTools(BrowserWindow, logger);
            }
          } catch (ignored) {}
        });
      } catch (ignored) {}
    };
    // Windows that already exist.
    try {
      var existing = BrowserWindow.getAllWindows();
      for (var i = 0; i < existing.length; i++) {
        attach(existing[i]);
      }
    } catch (ignored) {}
    // Windows created later.
    app.on("browser-window-created", function (event, win) {
      attach(win);
    });
  } catch (ignored) {}
}

function registerGlobal(electron, logger) {
  try {
    var globalShortcut = electron.globalShortcut;
    var BrowserWindow = electron.BrowserWindow;
    if (!globalShortcut || !BrowserWindow) {
      logger.warn("devtools-f12: globalShortcut/BrowserWindow unavailable");
      return false;
    }
    if (state.registered) {
      return true;
    }
    var ok = globalShortcut.register("F12", function () {
      toggleDevTools(BrowserWindow, logger);
    });
    state.registered = !!ok;
    return state.registered;
  } catch (err) {
    try {
      logger.warn("devtools-f12 register failed: " + (err && err.message ? err.message : err));
    } catch (ignored) {}
    return false;
  }
}

module.exports = {
  activate: function (ctx) {
    try {
      var electron = getElectron(ctx);
      if (!electron) {
        ctx.logger.warn(
          "devtools-f12: ctx.raw absent (needs developer mode + runtime.unsafe grant); F12 not registered"
        );
        return;
      }
      // globalShortcut requires app ready; defer when it is not.
      var app = electron.app;
      var ready =
        !app || (typeof app.isReady === "function" && app.isReady());
      var doRegister = function () {
        var ok = registerGlobal(electron, ctx.logger);
        ctx.logger.info("devtools-f12 activated (F12 registered: " + ok + ")");
      };
      if (ready) {
        doRegister();
      } else if (app && typeof app.whenReady === "function") {
        app.whenReady().then(doRegister, function (err) {
          try {
            ctx.logger.warn(
              "devtools-f12: app not ready (" + (err && err.message ? err.message : err) + ")"
            );
          } catch (ignored) {}
        });
      } else {
        doRegister();
      }
      // Focus-path fallback works regardless of global registration.
      attachWindowFallback(electron, ctx.logger);
    } catch (err) {
      try {
        ctx.logger.warn("devtools-f12 activate failed: " + (err && err.message ? err.message : err));
      } catch (ignored) {}
    }
  },
  deactivate: function (ctx) {
    try {
      var electron = getElectron(ctx);
      if (electron && electron.globalShortcut) {
        electron.globalShortcut.unregister("F12");
      }
    } catch (err) {
      // Best effort cleanup.
    }
    state.registered = false;
    try {
      ctx.logger.info("devtools-f12 deactivated");
    } catch (ignored) {}
  },
};

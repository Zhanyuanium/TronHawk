// DevTools F12 — developer-mode main plugin: pressing F12 while a window of
// the target app is focused toggles DevTools for that window.
//
// Mechanism: per-window `webContents` `before-input-event` listeners. There is
// deliberately NO system-global shortcut: a global F12 would be hijacked
// system-wide (breaking F12 in every other program) while only ever acting on
// the target app's focused window, so the per-window path covers the whole
// requirement with none of the side effects.
//
// Requires developer mode + the `runtime.unsafe` grant: `ctx.raw.electron` is
// the real Electron module of the injected app (see docs/PLUGIN-SDK.md §ctx.raw
// and ADR 0007). The grant is also the execution gate: without an effective
// `runtime.unsafe` grant Core drops the main payload, so the plugin never runs
// at all (the `ctx.raw absent` branch below is unreachable through the real
// pipeline and only guards against a broken host context).
//
// Lifecycle: every attached listener is tracked in `state` and removed in
// `deactivate`, so disabling the plugin or revoking `runtime.unsafe` leaves no
// live hooks behind. Attachments of closed windows are released eagerly via
// the `webContents` `destroyed` event instead of accumulating until deactivate.
var state = {
  active: false,
  // { app, handler } for the single `browser-window-created` subscription.
  appSubscription: null,
  // [{ contents, handler, destroyedHandler }] — one entry per attached webContents.
  windowAttachments: [],
};

function describeError(err) {
  if (err && err.message) {
    return err.message;
  }
  return String(err);
}

function getElectron(ctx) {
  if (ctx && ctx.raw && ctx.raw.electron) {
    return ctx.raw.electron;
  }
  return null;
}

// Only a bare F12 keyDown counts: no modifiers, no auto-repeat.
function isBareF12KeyDown(input) {
  if (!input || input.type !== "keyDown") {
    return false;
  }
  if (input.key !== "F12" && input.code !== "F12") {
    return false;
  }
  if (input.isAutoRepeat) {
    return false;
  }
  if (input.shift || input.control || input.alt || input.meta) {
    return false;
  }
  return true;
}

function toggleWebContentsDevTools(contents, logger) {
  try {
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
    } else {
      contents.openDevTools();
    }
  } catch (err) {
    logger.warn("devtools-f12: toggle failed: " + describeError(err));
  }
}

function removeListener(target, event, handler) {
  if (!target) {
    return;
  }
  if (typeof target.off === "function") {
    target.off(event, handler);
  } else if (typeof target.removeListener === "function") {
    target.removeListener(event, handler);
  }
}

function detachWindowAttachment(entry, logger) {
  try {
    removeListener(entry.contents, "before-input-event", entry.handler);
    removeListener(entry.contents, "destroyed", entry.destroyedHandler);
  } catch (err) {
    logger.warn("devtools-f12: detach failed: " + describeError(err));
  }
}

function dropWindowAttachment(entry) {
  for (var i = 0; i < state.windowAttachments.length; i++) {
    if (state.windowAttachments[i] === entry) {
      state.windowAttachments.splice(i, 1);
      return;
    }
  }
}

// Returns true when the window is now watched.
function attachWindow(win, logger) {
  var contents = win ? win.webContents : null;
  if (!contents || typeof contents.on !== "function") {
    logger.warn("devtools-f12: cannot watch a window without webContents; skipped");
    return false;
  }
  var entry = { contents: contents, handler: null, destroyedHandler: null };
  var handler = function (event, input) {
    try {
      if (!isBareF12KeyDown(input)) {
        return;
      }
      if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      // Toggle the webContents the event belongs to — never re-resolve the
      // focused window, which may already have moved on.
      toggleWebContentsDevTools(contents, logger);
    } catch (err) {
      logger.warn("devtools-f12: input handling failed: " + describeError(err));
    }
  };
  entry.handler = handler;
  // A closed window takes its listeners with it; drop our record eagerly so
  // long-lived apps with many transient windows cannot accumulate history.
  entry.destroyedHandler = function () {
    dropWindowAttachment(entry);
  };
  try {
    contents.on("before-input-event", handler);
    contents.on("destroyed", entry.destroyedHandler);
  } catch (err) {
    // Roll back the half-attached listener so a selective failure cannot
    // leave a live hook without a record.
    detachWindowAttachment(entry, logger);
    logger.warn("devtools-f12: attach failed: " + describeError(err));
    return false;
  }
  state.windowAttachments.push(entry);
  return true;
}

module.exports = {
  activate: function (ctx) {
    // Defensive: never stack listeners across a repeated activate without an
    // intervening deactivate.
    if (state.active) {
      module.exports.deactivate(ctx);
    }
    try {
      var electron = getElectron(ctx);
      if (!electron) {
        // Unreachable through the real pipeline (without an effective
        // `runtime.unsafe` grant the main payload never runs); kept as a
        // broken-host guard.
        ctx.logger.warn(
          "devtools-f12: host did not provide ctx.raw.electron; F12 not watched"
        );
        return;
      }
      var app = electron.app;
      var BrowserWindow = electron.BrowserWindow;
      if (!app || !BrowserWindow) {
        ctx.logger.warn("devtools-f12: app/BrowserWindow unavailable; F12 not watched");
        return;
      }
      state.active = true;
      var watched = 0;
      try {
        var existing = BrowserWindow.getAllWindows() || [];
        for (var i = 0; i < existing.length; i++) {
          if (attachWindow(existing[i], ctx.logger)) {
            watched++;
          }
        }
      } catch (err) {
        ctx.logger.warn("devtools-f12: enumerating windows failed: " + describeError(err));
      }
      var onWindowCreated = function (event, win) {
        if (!state.active) {
          return;
        }
        attachWindow(win, ctx.logger);
      };
      try {
        app.on("browser-window-created", onWindowCreated);
        state.appSubscription = { app: app, handler: onWindowCreated };
      } catch (err) {
        ctx.logger.warn("devtools-f12: subscribing to new windows failed: " + describeError(err));
      }
      ctx.logger.info("devtools-f12 activated (windows watched: " + watched + ")");
    } catch (err) {
      try {
        ctx.logger.warn("devtools-f12: activate failed: " + describeError(err));
      } catch (ignored) {}
    }
  },
  deactivate: function (ctx) {
    state.active = false;
    var logger = ctx && ctx.logger ? ctx.logger : null;
    var silent = {
      warn: function () {},
      info: function () {},
    };
    var log = logger || silent;
    if (state.appSubscription) {
      try {
        var app = state.appSubscription.app;
        var handler = state.appSubscription.handler;
        if (app) {
          if (typeof app.off === "function") {
            app.off("browser-window-created", handler);
          } else if (typeof app.removeListener === "function") {
            app.removeListener("browser-window-created", handler);
          }
        }
      } catch (err) {
        log.warn("devtools-f12: unsubscribing from new windows failed: " + describeError(err));
      }
      state.appSubscription = null;
    }
    for (var i = 0; i < state.windowAttachments.length; i++) {
      detachWindowAttachment(state.windowAttachments[i], log);
    }
    state.windowAttachments = [];
    try {
      log.info("devtools-f12 deactivated");
    } catch (ignored) {}
  },
};

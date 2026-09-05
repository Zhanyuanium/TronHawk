const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deterministic, in-memory (non-persistent) session for integration tests.
      partition: "tronhawk-test",
    },
    // Simulate a WCO application (titleBarStyle "hidden" + a titleBarOverlay with explicit
    // color/symbolColor/height — the same shape VS Code/WorkBuddy use on Windows) so the runtime's
    // generic WCO-elimination mechanism (the adapter `onWindowOptions` BrowserWindow wrap) can be
    // verified against this app: the native overlay buttons disappear when the adapter drops the
    // titleBarOverlay before the window is constructed.
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#2f3241", symbolColor: "#ffffff", height: 30 } }
      : {}),
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));
}

ipcMain.handle("ping", () => "pong");

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

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

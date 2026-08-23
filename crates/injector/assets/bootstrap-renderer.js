// TronHawk PoC — renderer capability test.
// Runs in the target's MAIN process; proves we can create a window and drive the
// renderer via webContents (main-world JS + CSS injection).
const fs = require("fs");
const path = require("path");
const os = require("os");

const marker = path.join(os.tmpdir(), "tronhawk-poc-renderer.txt");

function log(line) {
  fs.appendFileSync(marker, line + "\n");
}

try {
  const { app, BrowserWindow } = require("electron");
  log("require('electron') OK");

  app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 400, height: 300, show: false });
    win.webContents.on("did-finish-load", async () => {
      try {
        // 1) main-world JS execution
        const title = await win.webContents.executeJavaScript(
          "document.title = 'TRONHAWK'; document.title",
        );
        log("executeJavaScript (main world): title=" + title);

        // 2) CSS injection
        await win.webContents.insertCSS("body { background: rgb(1,2,3) !important; }");
        const bg = await win.webContents.executeJavaScript(
          "getComputedStyle(document.body).backgroundColor",
        );
        log("insertCSS: body backgroundColor=" + bg);

        log("RENDERER POC OK");
        app.quit();
      } catch (e) {
        log("renderer error: " + (e && e.message ? e.message : e));
        app.quit();
      }
    });
    win.loadURL(
      "data:text/html,<html><head><title>orig</title></head><body><h1>hello</h1></body></html>",
    );
  });
  log("app.whenReady registered");
} catch (e) {
  log("require('electron') failed: " + (e && e.message ? e.message : e));
}

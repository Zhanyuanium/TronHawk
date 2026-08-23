const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("testApp", {
  ping: () => ipcRenderer.invoke("ping"),
});

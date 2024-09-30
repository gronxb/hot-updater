const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("app", {
  getAppVersion: () => "Hello",
  getUpdateJson: () => ipcRenderer.invoke("getUpdateJson"),
});

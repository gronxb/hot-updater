const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("app", {
  getAppVersion: () => "Hello",
  getUpdateSources: () => ipcRenderer.invoke("getUpdateSources"),
});

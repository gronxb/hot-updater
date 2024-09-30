import { fileURLToPath } from "url";

import { getCwd, loadConfig } from "@hot-updater/plugin-core";

import path from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";

const __dirname = fileURLToPath(import.meta.url);

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    titleBarStyle: "hidden",
    title: "Hot Updater Console",
    trafficLightPosition: {
      x: 15,
      y: 13,
    },
    icon: path.resolve(__dirname, "..", "logo.png"),
    webPreferences: {
      preload: path.resolve(__dirname, "..", "preload.js"),
    },
  });

  if (process.env.NODE_ENV === "production") {
    mainWindow.webContents.openDevTools();
    mainWindow.loadURL("http://localhost:3000/");
  } else {
    mainWindow.loadFile("index.html");
  }
};

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const config = await loadConfig();
const deployPlugin = config.deploy({ cwd: getCwd() });

console.log("config", deployPlugin);
ipcMain.handle("getUpdateJson", async () => {
  return deployPlugin.getUpdateJson();
});

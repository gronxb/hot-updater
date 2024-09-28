const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { ipcMain } = require("electron");

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: {
        x: 15,
        y: 13,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  
  console.log(process.env.NOE_ENV);
  if(process.env.NODE_ENV === "development") {
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

ipcMain.handle("getUpdateSources", async () => {
  return []; // TODO: plugin api 
});

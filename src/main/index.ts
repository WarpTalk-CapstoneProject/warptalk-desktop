/**
 * WarpTalk Desktop — Electron Main Process Entry Point
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import path from "path";

import { AudioRuntimeService } from "./audio-runtime";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const audioRuntime = new AudioRuntimeService();

function registerIpcHandlers(): void {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("runtime:capability", () => audioRuntime.getCapability());
  ipcMain.handle("audio:start-capture", async () => undefined);
  ipcMain.handle("audio:stop-capture", async () => undefined);
  ipcMain.handle("translationRoom:join", async () => undefined);
  ipcMain.handle("translationRoom:leave", async () => undefined);

  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on("window:close", () => mainWindow?.close());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "WarpTalk",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Load renderer
  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Minimize to tray instead of closing
  mainWindow.on("close", (event) => {
    if (tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  // TODO: Replace with actual app icon
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("WarpTalk");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show WarpTalk",
      click: () => mainWindow?.show(),
    },
    { type: "separator" },
    {
      label: "Start Translation",
      click: () => {
        // TODO: Start audio capture & translation pipeline
      },
    },
    {
      label: "Stop Translation",
      click: () => {
        // TODO: Stop audio capture
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        tray?.destroy();
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    mainWindow?.show();
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

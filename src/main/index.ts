/**
 * WarpTalk Desktop - Electron Main Process Entry Point
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";

import { AudioRuntimeService } from "./audio-runtime";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const audioRuntime = new AudioRuntimeService();
const APP_NAME = "Warptalk-V1";
const APP_MODEL_ID = "com.warptalk.desktop";
const WINDOW_TITLE = "";

app.setName(APP_NAME);
app.setAppUserModelId(APP_MODEL_ID);

function getDesktopAssetPath(fileName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.resolve(process.cwd(), "resources", fileName);
}

function registerIpcHandlers(): void {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("runtime:capability", () => audioRuntime.getCapability());
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    openExternalUrl(url);
  });
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

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: getDesktopAssetPath("warptalk-logo-primary.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(WINDOW_TITLE);
  });

  const devRendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devRendererUrl) {
    await mainWindow.loadURL(devRendererUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setTitle(WINDOW_TITLE);

  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
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

function openExternalUrl(url: string): void {
  if (process.platform === "win32") {
    const chromePaths = [
      path.join(
        process.env.PROGRAMFILES ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
    const chromePath = chromePaths.find(
      (candidate) => candidate && fs.existsSync(candidate),
    );
    if (chromePath) {
      const child = spawn(chromePath, [url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
  }

  void shell.openExternal(url);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(
    getDesktopAssetPath("warptalk-logo-primary.ico"),
  );

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Show ${APP_NAME}`,
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
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  void createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

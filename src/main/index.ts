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
import { WebRuntimeService } from "./web-runtime";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const audioRuntime = new AudioRuntimeService();
const webRuntime = new WebRuntimeService();
const APP_NAME = "Warptalk-V1";
const APP_MODEL_ID = "com.warptalk.desktop";
const WINDOW_TITLE = "";
const GOOGLE_AUTH_HOSTS = new Set([
  "accounts.google.com",
  "oauth.googleusercontent.com",
]);
// nativeImage only decodes .ico on Windows; macOS/Linux need the PNG or they
// get an empty image (invisible tray, blank window icon).
const APP_ICON_FILE =
  process.platform === "win32"
    ? "warptalk-logo-primary.ico"
    : "warptalk-logo-primary.png";
// The app icon is a black square, which would disappear against a dark menu
// bar, so the tray gets the mark on a transparent background instead.
const TRAY_ICON_FILE = "warptalk-tray.png";

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

function getUrlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function shouldAllowAuthPopup(url: string): boolean {
  if (url === "about:blank") {
    return true;
  }

  try {
    const target = new URL(url);
    return GOOGLE_AUTH_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}

function isDesktopLandingUrl(url: string, trustedOrigin: string): boolean {
  try {
    const target = new URL(url);
    return target.origin === trustedOrigin && target.pathname === "/";
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: getDesktopAssetPath(APP_ICON_FILE),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  // Everything below must be wired before the first await: the user can close
  // the window while the web UI is still loading, and a listener attached after
  // that point never runs.
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(WINDOW_TITLE);
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // Minimize to tray instead of closing
  win.on("close", (event) => {
    if (tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);
  win.setTitle(WINDOW_TITLE);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }

  try {
    const rendererUrl = await webRuntime.getRendererUrl();
    if (win.isDestroyed()) return;

    const trustedOrigin = webRuntime.getTrustedOrigin(rendererUrl);
    const desktopEntryUrl = webRuntime.getDesktopEntryUrl(rendererUrl);
    const reloadDesktopEntry = (): void => {
      void win.loadURL(desktopEntryUrl).catch((error) => {
        console.error("Failed to reload the desktop entry route:", error);
      });
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      const targetOrigin = getUrlOrigin(url);
      if (targetOrigin === trustedOrigin) {
        return { action: "allow" };
      }

      if (shouldAllowAuthPopup(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }

      openExternalUrl(url);
      return { action: "deny" };
    });

    win.webContents.on("will-navigate", (event, url) => {
      const targetOrigin = getUrlOrigin(url);
      if (isDesktopLandingUrl(url, trustedOrigin)) {
        event.preventDefault();
        reloadDesktopEntry();
        return;
      }

      if (!targetOrigin || targetOrigin === trustedOrigin) return;

      event.preventDefault();
      openExternalUrl(url);
    });

    win.webContents.on("did-navigate-in-page", (_event, url) => {
      if (isDesktopLandingUrl(url, trustedOrigin)) {
        reloadDesktopEntry();
      }
    });

    await win.loadURL(desktopEntryUrl);
  } catch (error) {
    // Offline, DNS failure, the deployed app being down, or the local web
    // runtime failing to come up. Without this the window stays blank forever.
    console.error("Failed to load the WarpTalk web UI:", error);
    if (win.isDestroyed()) return;

    try {
      await win.loadFile(path.join(__dirname, "../renderer/index.html"));
    } catch (fallbackError) {
      console.error("Failed to load the fallback renderer:", fallbackError);
    }
  }
}

/**
 * The preload bridge is exposed to remotely-hosted content, so any script on the
 * deployed origin can reach `openExternal`. Without this check a `file://` URL
 * would launch a local binary through ShellExecute, and a switch-shaped string
 * would be handed to chrome.exe as an argument.
 */
function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) {
    console.warn(`Blocked external URL with unsupported scheme: ${url}`);
    return;
  }

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
      // "--" terminates switch parsing, so the URL can never be read as a flag.
      const child = spawn(chromePath, ["--", url], {
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
  let icon = nativeImage.createFromPath(getDesktopAssetPath(TRAY_ICON_FILE));

  // `close` hides the window whenever a tray exists, so an undecodable or
  // missing icon would strand the window behind an invisible tray item.
  if (icon.isEmpty()) {
    console.error(
      `Tray icon ${TRAY_ICON_FILE} could not be loaded; running without a tray.`,
    );
    return;
  }

  // The asset ships at 64px; menu bars want ~16pt and the Windows notification
  // area ~32px at the DPI scales it actually runs at.
  const traySize = process.platform === "darwin" ? 16 : 32;
  icon = icon.resize({ width: traySize, height: traySize });

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

function launchWindow(): void {
  void createWindow().catch((error) => {
    console.error("Failed to create the main window:", error);
  });
}

/**
 * On macOS the standard editing shortcuts (Cmd+C/V/X/A) and Cmd+Q are provided
 * by roles in the application menu, so dropping the menu entirely would take
 * them with it. The window itself is chromeless on every platform: Windows and
 * Linux hide the menu bar via `autoHideMenuBar` + `setMenuBarVisibility(false)`.
 */
function applyApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(() => {
  applyApplicationMenu();
  registerIpcHandlers();
  launchWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      launchWindow();
    }
  });
});

app.on("before-quit", () => {
  webRuntime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

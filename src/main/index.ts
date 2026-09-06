/**
 * WarpTalk Desktop - Electron Main Process Entry Point
 */

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";

import { AudioRuntimeService } from "./audio-runtime";
import {
  createNativeWindowsLoopbackAdapter,
  WindowsLoopbackRuntime,
} from "./windows-loopback-runtime";
import { MeetPresenceWatcher } from "./meet-presence";
import type { MeetPresence } from "../shared/types";
import {
  describeWindowsLoopbackSources,
  resolveWindowOwnerProcessId,
} from "./windows-loopback-sources";
import {
  BLACKHOLE_BREW_COMMAND,
  BLACKHOLE_DOWNLOAD_PAGE,
  VBCABLE_DOWNLOAD_PAGE,
  detectVirtualAudio,
  hasHomebrew,
} from "./virtual-audio";
import { WebRuntimeService } from "./web-runtime";

let mainWindow: BrowserWindow | null = null;
let transcriptWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/**
 * Where the web UI is being served from, captured once the main window has resolved it. The
 * transcript popup needs the same origin and must not resolve it a second time: in local-packaged
 * mode that would fork a second Next server.
 */
let resolvedWebOrigin: string | null = null;
const audioRuntime = new AudioRuntimeService();

/**
 * Watches for a Google Meet window so the bridge widget can appear when the user is actually in
 * the call, rather than when they happen to open the room in WarpTalk.
 *
 * Armed by the renderer and only by the renderer: enumerating every window on the machine is not
 * something to do on the chance a meeting might start. The renderer knows when a bridge meeting is
 * near; main does not, and giving main that knowledge would mean giving it the API session too.
 *
 * On macOS the titles come back generic unless screen recording has been granted, so this reports
 * "no Meet visible" there. That degrades to the schedule-only trigger, which needs no window
 * knowledge at all - a worse answer, never a wrong one.
 */
const meetPresenceWatcher = new MeetPresenceWatcher({
  listWindowTitles: async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((source) => source.name);
  },
  onChange: (presence: MeetPresence) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:meet-presence", presence);
    }
  },
});
const windowsLoopbackRuntime = new WindowsLoopbackRuntime(
  createNativeWindowsLoopbackAdapter({
    publishPcmChunk: (chunk) => {
      mainWindow?.webContents.send("audio:loopback-pcm-chunk", chunk);
    },
    resolveTargetProcessId: async (sourceId) => resolveWindowOwnerProcessId(sourceId),
  }),
);
const webRuntime = new WebRuntimeService();
const APP_NAME = "WarpTalk";
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
// bar, so the tray gets the mark on a transparent background instead. macOS
// takes a monochrome template image and inverts it per menu bar appearance;
// Windows and Linux have no such concept and get the colour mark.
const TRAY_ICON_FILE =
  process.platform === "darwin"
    ? "warptalk-tray-template.png"
    : "warptalk-tray.png";

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
  ipcMain.handle("audio:start-capture", async (_event, request) =>
    windowsLoopbackRuntime.start(request),
  );
  ipcMain.handle("audio:stop-capture", async () => windowsLoopbackRuntime.stop());
  // Arm/disarm rather than a query: the renderer would otherwise have to poll main, which polls
  // the OS, and two loops out of step is how a widget ends up a few seconds behind the meeting.
  ipcMain.handle("bridge:watch-meet-presence", () => {
    meetPresenceWatcher.arm();
  });
  ipcMain.handle("bridge:unwatch-meet-presence", () => {
    meetPresenceWatcher.disarm();
  });
  ipcMain.handle("audio:list-loopback-sources", async () => {
    if (process.platform !== "win32") return [];

    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
      });
    } catch (error) {
      console.error("Could not enumerate Windows loopback window sources:", error);
      return [];
    }

    return describeWindowsLoopbackSources(sources);
  });
  ipcMain.handle("translationRoom:join", async () => undefined);
  ipcMain.handle("translationRoom:leave", async () => undefined);

  // External-bridge meetings: which virtual audio devices exist, and a window that shows the
  // transcript while the user is looking at Google Meet rather than at WarpTalk.
  // The runtime is the only thing that knows whether capture could actually start, and the web tier
  // picker chooses the loopback rung from the answer — so it is asked here rather than guessed from
  // the Windows build number.
  // Awaited, because `isReady()` is now a probe result rather than a platform check. Asking
  // before the probe settles would publish "not-wired" for a machine that is wired, and the web
  // tier picker reads exactly this field to decide whether the loopback rung is on offer.
  ipcMain.handle("bridge:virtual-audio-status", async () => {
    await windowsLoopbackRuntime.whenProbed();
    return detectVirtualAudio(windowsLoopbackRuntime.isReady());
  });
  ipcMain.handle("bridge:install-virtual-audio", () => runVirtualAudioInstaller());
  ipcMain.handle("bridge:open-transcript-window", async (_event, roomId: string | null) => {
    await openTranscriptWindow(roomId ?? null);
  });
  /**
   * Flow 2's last mile: the offer window has made a room, and the SESSION has to start.
   *
   * It cannot start it itself. The translation pipeline lives in the main window's meeting
   * session, keyed off a store held in sessionStorage - which is per-window, so nothing the
   * popup writes is visible to the main window. Main relays instead.
   */
  ipcMain.handle("bridge:activate-room", (_event, roomId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:room-activated", roomId);
    }
  });
  ipcMain.handle("bridge:close-transcript-window", () => {
    transcriptWindow?.close();
  });

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
    resolvedWebOrigin = trustedOrigin;
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

/** The compact transcript view the popup shows. Served by the web app, not by the local renderer. */
const TRANSCRIPT_ROUTE = "/desktop-transcript";
/** Flow 2: a Meet is on screen that no room accounts for. The window asks before anything is made. */
const BRIDGE_OFFER_ROUTE = "/desktop-bridge-offer";

/**
 * A second, small, always-on-top window carrying the live transcript.
 *
 * It exists because an external-bridge meeting is one the user is watching in Google Meet, not in
 * WarpTalk — the main window is behind their browser the whole time, so a transcript inside it is
 * a transcript nobody reads.
 *
 * Follows the main window's construction order deliberately: every listener is attached before the
 * first await, and the load is wrapped, because a window whose `closed` handler was registered
 * after an await leaves a destroyed object behind for the next caller to touch.
 */
async function openTranscriptWindow(roomId: string | null): Promise<void> {
  if (!resolvedWebOrigin) {
    console.error("Cannot open the transcript window before the web UI has loaded.");
    return;
  }

  const target = roomId
    ? `${resolvedWebOrigin}${TRANSCRIPT_ROUTE}/${encodeURIComponent(roomId)}`
    : `${resolvedWebOrigin}${BRIDGE_OFFER_ROUTE}`;

  if (transcriptWindow && !transcriptWindow.isDestroyed()) {
    if (transcriptWindow.isMinimized()) transcriptWindow.restore();
    transcriptWindow.show();
    transcriptWindow.focus();
    // Reusing the window is not the same as leaving it where it was. The offer becomes a
    // transcript the moment the user accepts, and this used to return early on the strength of a
    // window merely existing - so the accepted offer stayed on screen, showing the question it had
    // already been answered.
    if (transcriptWindow.webContents.getURL() !== target) {
      try {
        await transcriptWindow.loadURL(target);
      } catch (error) {
        console.error("Failed to move the bridge window:", error);
      }
    }
    return;
  }

  const win = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 320,
    minHeight: 240,
    title: WINDOW_TITLE,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    // Small and unobtrusive: it sits over a browser window for the whole meeting.
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  transcriptWindow = win;

  win.on("closed", () => {
    if (transcriptWindow === win) {
      transcriptWindow = null;
    }
  });

  // Unlike the main window, closing this one really closes it — it is a panel the user dismisses,
  // not the application.
  win.setMenuBarVisibility(false);

  // Same containment as the main window: a link in a transcript must not navigate the panel to
  // some other site, and popups from it go to the browser.
  const popupOrigin = resolvedWebOrigin;
  win.webContents.on("will-navigate", (event, url) => {
    if (getUrlOrigin(url) === popupOrigin) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  try {
    await win.loadURL(target);
  } catch (error) {
    console.error("Failed to load the transcript view:", error);
    if (win.isDestroyed()) return;
    try {
      await win.loadFile(path.join(__dirname, "../renderer/index.html"));
    } catch (fallbackError) {
      console.error("Failed to load the fallback renderer:", fallbackError);
    }
  }
}

/**
 * Hands the bundled virtual-audio installer to the OS installer UI.
 *
 * Deliberately not silent. It writes into /Library and needs an administrator, so the user is told
 * what is about to run and what it is for before any password prompt appears — a password box that
 * arrives unexplained is one people are right to refuse.
 */
async function runVirtualAudioInstaller(): Promise<{ started: boolean; reason?: string }> {
  if (process.platform === "win32") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Install the Windows audio bridge cable",
      detail:
        "Windows bridge mode uses the free VB-CABLE driver for the outbound leg. Install it from " +
        "VB-Audio, reboot if the installer asks, then choose CABLE Output as the microphone in " +
        "your meeting app.\n\n" +
        "WarpTalk does not install a driver silently or change your Windows default audio device.",
      buttons: ["Open the download page", "Not now"],
      cancelId: 1,
      defaultId: 0,
    });

    if (response === 1) {
      return { started: false, reason: "declined" };
    }

    openExternalUrl(VBCABLE_DOWNLOAD_PAGE);
    return { started: true, reason: "download-page-opened" };
  }

  if (process.platform !== "darwin") {
    return { started: false, reason: "unsupported-platform" };
  }

  const brew = hasHomebrew();
  const buttons = brew
    ? ["Copy the Homebrew command", "Open the download page", "Not now"]
    : ["Open the download page", "Not now"];

  const { response } = await dialog.showMessageBox({
    type: "info",
    message: "Install the audio bridge",
    detail:
      "An external meeting needs two virtual audio devices so Google Meet can send and receive " +
      "translated audio. WarpTalk uses BlackHole, which is free and open source.\n\n" +
      (brew ? `Homebrew is installed, so this one command sets both up:\n\n${BLACKHOLE_BREW_COMMAND}\n\n` : "") +
      "It installs system-wide, so macOS will ask for your password and the devices appear " +
      "after a restart. WarpTalk does not run the install itself — the password stays between " +
      "you and macOS. To undo it later, remove the BlackHole entries from " +
      "/Library/Audio/Plug-Ins/HAL.",
    buttons,
    cancelId: buttons.length - 1,
    defaultId: 0,
  });

  if (response === buttons.length - 1) {
    return { started: false, reason: "declined" };
  }

  if (brew && response === 0) {
    clipboard.writeText(BLACKHOLE_BREW_COMMAND);
    return { started: true, reason: "command-copied" };
  }

  openExternalUrl(BLACKHOLE_DOWNLOAD_PAGE);
  return { started: true, reason: "download-page-opened" };
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

  if (process.platform === "darwin") {
    // Already 16pt with an @2x sibling for retina; marking it a template lets
    // macOS draw it dark on a light menu bar and light on a dark one.
    icon.setTemplateImage(true);
  } else {
    // The colour asset ships at 64px; the notification area wants about 32px
    // at the DPI scales it actually runs at.
    icon = icon.resize({ width: 32, height: 32 });
  }

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
 * Without this handler Chromium rejects `getDisplayMedia` with
 * "NotSupportedError: Not supported", so the meeting control bar's Present
 * button does nothing. Electron 28 has no `useSystemPicker`, so the source has
 * to be chosen here.
 */
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void (async () => {
      // macOS refuses to enumerate screens until Screen Recording is granted,
      // and cannot be prompted from here — the first capture attempt is what
      // makes the entry appear in System Settings.
      if (
        process.platform === "darwin" &&
        systemPreferences.getMediaAccessStatus("screen") !== "granted"
      ) {
        console.warn("Screen recording permission has not been granted yet.");
      }

      let sources;
      try {
        sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
      } catch (error) {
        console.error("Could not enumerate screen sources:", error);
        callback({});
        return;
      }

      if (sources.length === 0) {
        await dialog.showMessageBox({
          type: "warning",
          message: "Screen sharing is unavailable",
          detail:
            process.platform === "darwin"
              ? `Grant ${APP_NAME} the Screen Recording permission in System Settings > Privacy & Security, then try again.`
              : "No screen could be captured.",
        });
        callback({});
        return;
      }

      if (sources.length === 1) {
        callback({ video: sources[0] });
        return;
      }

      const { response } = await dialog.showMessageBox({
        type: "question",
        message: "Share which screen?",
        buttons: [...sources.map((source) => source.name), "Cancel"],
        cancelId: sources.length,
        defaultId: 0,
      });

      if (response >= sources.length) {
        callback({});
        return;
      }

      callback({ video: sources[response] });
    })();
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

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    launchWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// A second copy would run its own tray and, in local-packaged mode, fork a
// second Next server on another port. Hand the launch to the running instance
// instead. Must be claimed before `whenReady` so the loser exits early.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealMainWindow);

  app.whenReady().then(() => {
    applyApplicationMenu();
    registerIpcHandlers();
    registerDisplayMediaHandler();
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
}

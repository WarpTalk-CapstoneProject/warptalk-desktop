/**
 * WarpTalk Desktop - Electron Main Process Entry Point
 */

import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
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
import { MeetUrlSensor } from "./meet-url-sensor";
import { MacMeetUrlSensor } from "./meet-url-sensor-mac";
import { MeetCaptionSensor } from "./meet-caption-sensor";
import { MeetCaptionBuffer } from "./meet-caption-buffer";
import {
  MEET_CODE,
  MeetCaptionStream,
  alignedNow,
  ensureCaptionsOn,
  meetCaptionNamesEnabled,
  singleFlight,
} from "./meet-captions";
import { MeetMicStateStream, MicSessionSensor } from "./meet-mic-state";
import { TranscriptPanelLedger } from "./transcript-panel";
import { SignedOutMeetPrompt } from "./signed-out-meet-prompt";
import { trayMenuTemplate } from "./tray-menu";
import { shouldHideOnClose, shouldIgnoreBeforeUnload } from "./quit-lifecycle";
import {
  checkForUpdatesInteractive,
  getUpdatePhase,
  initAutoUpdater,
  installUpdate,
  onMainWindowShown,
} from "./updater";
import { trayBadged, trayTooltip, trayUpdateLabel } from "./update-policy";
import { withUpdateDot } from "./tray-badge";
import type { EnsureMeetCaptionsResult, MeetMicState, MeetPresence } from "../shared/types";
import {
  describeWindowsLoopbackSources,
  resolveWindowOwnerProcessId,
} from "./windows-loopback-sources";
import {
  BLACKHOLE_BREW_COMMAND,
  BLACKHOLE_DOWNLOAD_PAGE,
  MAC_BUNDLED_DRIVERS,
  VBCABLE_DOWNLOAD_PAGE,
  buildMacDriverInstallScript,
  detectVirtualAudioWithFormats,
  hasHomebrew,
  toAppleScriptAdminCommand,
} from "./virtual-audio";
import { WebRuntimeService } from "./web-runtime";
import {
  alignHiFiCableFormat,
  isHiFiFormatMismatch,
  readHiFiCableFormats,
} from "./audio-device-format";
import {
  PLUGIN_CONNECT_SCHEME,
  firstPluginConnectLink,
  pluginConnectTarget,
} from "./plugin-connect-link";

let mainWindow: BrowserWindow | null = null;
/** The bridge popup, and what the web app asked it to show. See transcript-panel.ts. */
const transcriptPanel = new TranscriptPanelLedger<BrowserWindow>();
let tray: Tray | null = null;
/** The tray icon as loaded, and with the "update waiting" dot. See tray-badge.ts. */
let trayIcon: Electron.NativeImage | null = null;
let trayIconBadged: Electron.NativeImage | null = null;
/** Whether the renderer has a loopback capture running, i.e. a bridge meeting is being translated. */
let loopbackCapturing = false;
/** Set once the app has decided to quit, before any window is asked to close. See quit-lifecycle.ts. */
let isQuitting = false;
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
 * Armed by the renderer's bridge trigger, which knows when a bridge meeting is near; main does not,
 * and giving main that knowledge would mean giving it the API session too. The one exception is a
 * signed-out app, where that trigger never mounts: main then arms it itself, only to offer a
 * sign-in. See signed-out-meet-prompt.ts.
 *
 * The sensor reads the browser's own URL rather than the window title. A title is written by the
 * page and so is worthless as a trust boundary; an address is not. See meet-url-sensor.ts.
 *
 * Windows reads it through UI Automation; macOS asks the browser over Apple Events, which raises
 * the system's own "WarpTalk wants to control Google Chrome" prompt the first time (see
 * meet-url-sensor-mac.ts). Linux has no sensor: every read fails, which the watcher treats as
 * "could not look" and therefore reports nothing. That degrades to the schedule-only trigger,
 * which needs no window knowledge at all - a worse answer, never a wrong one.
 */
const meetUrlSensor = process.platform === "darwin" ? new MacMeetUrlSensor() : new MeetUrlSensor();

const meetPresenceWatcher = new MeetPresenceWatcher({
  readMeetSighting: () => meetUrlSensor.read(),
  onChange: (presence: MeetPresence) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:meet-presence", presence);
    }
    signedOutMeetPrompt.presence(presence);
  },
});

/** Main's own use of the watcher while nobody is signed in. See signed-out-meet-prompt.ts. */
const signedOutMeetPrompt = new SignedOutMeetPrompt({
  armWatcher: () => meetPresenceWatcher.arm(),
  disarmWatcher: () => {
    meetPresenceWatcher.disarm();
    // Same as the web app's disarm: the helper shell would otherwise outlive the watch.
    meetUrlSensor.stop();
  },
  notify: () => announceSignInForMeet(),
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

/**
 * Speaker names from Google Meet's own captions (see meet-captions.ts). Windows only; behind the
 * `bridgeMeetCaptionNames` flag (env WARPTALK_BRIDGE_MEET_CAPTION_NAMES, default ON, dev and
 * packaged; 0/false/off is the kill switch).
 * The helper is a PowerShell process of its own, started on first use and stopped with the stream.
 */
const bridgeMeetCaptionNames =
  process.platform === "win32" &&
  meetCaptionNamesEnabled(process.env.WARPTALK_BRIDGE_MEET_CAPTION_NAMES, app.isPackaged);
const meetCaptionSensor = new MeetCaptionSensor();
// Events go through a 30 s buffer while the main window's renderer is not subscribed (loading,
// reloading, or not yet asked for the stream); see meet-caption-buffer.ts.
const meetCaptionBuffer = new MeetCaptionBuffer({
  now: alignedNow,
  send: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("bridge:meet-caption", event);
  },
  sendStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("bridge:meet-caption-status", status);
  },
});
const meetCaptionStream = new MeetCaptionStream({
  sensor: meetCaptionSensor,
  now: alignedNow,
  audioActive: () => loopbackCapturing,
  emit: (event) => meetCaptionBuffer.event(event),
  emitStatus: (status) => meetCaptionBuffer.status(status),
});
const ensureMeetCaptionsOnce = singleFlight((meetCode) => ensureCaptionsOn(meetCaptionSensor, meetCode));

/**
 * Which microphone the Meet browser records from, for the Text -> Voice notice (meet-mic-state.ts).
 * Windows only, read-only. Polled only while at least one window is subscribed; every subscriber
 * (main window, bridge popup) gets the events, and the helper is killed when the last one leaves.
 */
const meetMicSubscribers = new Map<Electron.WebContents, () => void>();
/** A browser PID a subscriber named explicitly; otherwise the loopback capture's target is used. */
let meetMicBrowserPid: number | null = null;
const meetMicStream = new MeetMicStateStream({
  sensor: new MicSessionSensor(),
  browserPid: () => meetMicBrowserPid ?? windowsLoopbackRuntime.activeTargetProcessId,
  // Our own tree is excluded by ancestry anyway; the metrics list also covers any helper Electron
  // reparented.
  excludePids: () => [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)],
  emit: (state) => sendMeetMicState(state),
});

function sendMeetMicState(state: MeetMicState, only?: Electron.WebContents): void {
  for (const contents of only ? [only] : meetMicSubscribers.keys()) {
    if (!contents.isDestroyed()) contents.send("bridge:meet-mic-state", state);
  }
}

function unsubscribeMeetMic(contents: Electron.WebContents): void {
  meetMicSubscribers.get(contents)?.();
  meetMicSubscribers.delete(contents);
  if (meetMicSubscribers.size === 0) {
    meetMicStream.stop();
    meetMicBrowserPid = null;
  }
}

function meetCodeFrom(request: unknown): string | null {
  const code = typeof request === "string" ? request : (request as { meetCode?: unknown } | null)?.meetCode;
  return typeof code === "string" && MEET_CODE.test(code) ? code : null;
}
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
  ipcMain.handle("audio:start-capture", async (_event, request) => {
    const result = await windowsLoopbackRuntime.start(request);
    loopbackCapturing = result.started;
    return result;
  });
  ipcMain.handle("audio:stop-capture", async () => {
    loopbackCapturing = false;
    return windowsLoopbackRuntime.stop();
  });
  // Arm/disarm rather than a query: the renderer would otherwise have to poll main, which polls
  // the OS, and two loops out of step is how a widget ends up a few seconds behind the meeting.
  ipcMain.handle("bridge:watch-meet-presence", () => {
    meetPresenceWatcher.arm();
    signedOutMeetPrompt.webArmedWatcher();
  });
  ipcMain.handle("bridge:unwatch-meet-presence", () => {
    meetPresenceWatcher.disarm();
    // The helper is one long-lived shell. Disarming without killing it would leave a PowerShell
    // process alive for the rest of the session, polling nothing.
    meetUrlSensor.stop();
    signedOutMeetPrompt.webDisarmedWatcher();
  });
  // Whether anyone is signed in to the web app. Optional on the web side: a web app that never
  // sends it is "unknown", which prompts only after the grace period passes without an arm.
  ipcMain.handle("auth:signed-in-state", (_event, state: unknown) => {
    const signedIn = (state as { signedIn?: unknown } | null)?.signedIn;
    if (typeof signedIn !== "boolean") return;
    signedOutMeetPrompt.reportSignedIn(signedIn);
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

    // Our own windows are removed before the renderer ever sees them. The hard refusal lives in
    // the start gate (R1 / target-is-warptalk) because ownerProcessId is resolved only for the
    // first window of each process; this just keeps the obvious wrong answer out of the picker.
    const described = await describeWindowsLoopbackSources(sources);
    return described.filter((source) => source.ownerProcessId !== process.pid);
  });
  // Meet captions -> live speaker names. `ensure` turns CC on via Meet's own button (never off,
  // never focus or keys); `stream` reads the captions while the bridge translates.
  ipcMain.handle("bridge:ensure-meet-captions", async (_event, request: unknown): Promise<EnsureMeetCaptionsResult> => {
    if (process.platform !== "win32") return { ok: false, state: "unknown", reason: "unsupported-platform" };
    if (!bridgeMeetCaptionNames) return { ok: false, state: "unknown", reason: "disabled" };
    const meetCode = meetCodeFrom(request);
    if (!meetCode) return { ok: false, state: "unknown", reason: "invalid-meet-code" };
    try {
      const result = await ensureMeetCaptionsOnce(meetCode);
      console.log("Meet captions ensure:", JSON.stringify(result));
      return result;
    } catch (error) {
      return { ok: false, state: "unknown", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      // Nothing else needs the helper: do not leave a PowerShell running for the session.
      if (!meetCaptionStream.activeMeetCode) meetCaptionSensor.stop();
    }
  });
  ipcMain.handle("bridge:meet-captions-stream", (event, request: unknown) => {
    if (!bridgeMeetCaptionNames) return;
    const enabled = (request as { enabled?: unknown } | null)?.enabled === true;
    const meetCode = meetCodeFrom(request);
    // Only the main window carries the hub connection the hints travel on.
    const fromMainWindow = mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    if (enabled && meetCode) {
      // A renderer that reloaded asks again for the same meeting: `start` is then a no-op and the
      // subscribe below hands over what was read while it was away.
      if (meetCaptionStream.activeMeetCode !== meetCode) meetCaptionBuffer.clear();
      meetCaptionStream.start(meetCode);
      if (fromMainWindow) meetCaptionBuffer.subscribe(meetCode);
    } else if (!meetCode || meetCaptionStream.activeMeetCode === meetCode) {
      // Stop first: its final flush still reaches the subscribed renderer.
      meetCaptionStream.stop();
      meetCaptionSensor.stop();
      meetCaptionBuffer.unsubscribe();
      meetCaptionBuffer.clear();
    }
  });
  ipcMain.handle("bridge:meet-mic-state-stream", (event, request: unknown) => {
    const contents = event.sender;
    const options = (request ?? {}) as { enabled?: unknown; browserPid?: unknown };
    if (options.enabled !== true) {
      unsubscribeMeetMic(contents);
      return;
    }
    if (process.platform !== "win32") {
      sendMeetMicState({ state: "unknown", reason: "unsupported-platform", at: Date.now() }, contents);
      return;
    }
    const pid = options.browserPid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      meetMicBrowserPid = pid;
    }
    if (!meetMicSubscribers.has(contents)) {
      // A page that went away (closed, crashed, navigated to another document) stops counting as a
      // subscriber; one that comes back asks again. In-page (SPA) navigations keep it.
      const leave = () => unsubscribeMeetMic(contents);
      contents.once("destroyed", leave);
      contents.on("render-process-gone", leave);
      contents.on("did-navigate", leave);
      meetMicSubscribers.set(contents, () => {
        contents.off("destroyed", leave);
        contents.off("render-process-gone", leave);
        contents.off("did-navigate", leave);
      });
    }
    if (meetMicStream.isRunning) {
      // A second subscriber, or a renderer that reloaded: hand it the current answer now.
      const current = meetMicStream.current;
      if (current) sendMeetMicState(current, contents);
    } else {
      meetMicStream.start();
    }
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
    return detectVirtualAudioWithFormats(windowsLoopbackRuntime.isReady());
  });
  ipcMain.handle("bridge:install-virtual-audio", () => runVirtualAudioInstaller());
  // Single-flight inside alignHiFiCableFormat: a click while the startup align is still running
  // joins that attempt instead of starting a second one on the same endpoints.
  ipcMain.handle("bridge:align-hifi-format", async () => {
    const result = await alignHiFiCableFormat();
    console.log("Hi-Fi Cable format alignment:", JSON.stringify(result));
    return result;
  });
  ipcMain.handle("bridge:open-transcript-window", async (_event, roomId: unknown) => {
    // Only a real room has a popup. The roomless "offer" it once also opened is gone from the web
    // app (web #505); a stale caller asking for it gets nothing rather than a 404 in a window.
    if (typeof roomId !== "string" || roomId.length === 0) return;
    transcriptPanel.request(roomId);
    refreshTrayMenu();
    await openTranscriptWindow(roomId);
  });
  /**
   * The popup asks for the room's session to start.
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
    // Withdrawn before it is closed, so the `closed` handler knows this one was asked for and
    // does not report it back as the user's. See transcript-panel.ts.
    const win = transcriptPanel.withdraw();
    refreshTrayMenu();
    if (win && !win.isDestroyed()) win.close();
  });
  /**
   * Brings the main window forward - from the tray, minimized, or behind the browser.
   *
   * The popup has no End meeting: a bridge meeting ends when the Google Meet call does. When the
   * web app learns the room ended it navigates the main window to the room itself and calls this,
   * so the user lands on the record as they would after a native meeting. The popup is left alone;
   * what it shows next is the web app's call.
   */
  ipcMain.handle("bridge:show-main-window", () => {
    revealMainWindow();
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

/**
 * `about:blank` used to be allowed unconditionally, and the protocol was never checked.
 *
 * A blank popup inherits its opener's origin, so the renderer could write arbitrary markup into a
 * window wearing this app's chrome — a credential prompt that looks like ours because, to the
 * window manager, it is. And matching on `hostname` alone admitted `http://accounts.google.com`,
 * which downgrades an auth flow to plaintext on whatever network the user is on.
 *
 * Host-confusion attempts (`https://accounts.google.com@evil.com`, `accounts.google.com.evil.com`)
 * were already handled correctly by parsing rather than string-matching; that part is unchanged.
 */
function shouldAllowAuthPopup(url: string): boolean {
  try {
    const target = new URL(url);
    return target.protocol === "https:" && GOOGLE_AUTH_HOSTS.has(target.hostname);
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
      /**
       * This window does realtime audio work while nobody is looking at it, which is not an edge
       * case here — it is the designed use. During a bridge meeting the user is in Google Meet,
       * WarpTalk is behind it, and this renderer is still decoding inbound PCM into a publishable
       * track and playing the outbound dub into the virtual cable. Closing the window does not even
       * end that: `close` hides to the tray rather than quitting.
       *
       * Chromium throttles timers in hidden pages, and while an audible page is exempt from the
       * most aggressive tiers, the exemption is a heuristic about playback rather than a guarantee
       * for a page assembling audio buffer by buffer. Paying full timer resolution for the length
       * of a meeting is the right trade against a translation that arrives late in bursts.
       *
       * The same holds for Meet caption hints: this renderer batches them onto the hub on a timer
       * (every few hundred ms), and a throttled timer in a hidden window would hold speaker names
       * back until they no longer match the speech they belong to.
       */
      backgroundThrottling: false,
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
      meetCaptionBuffer.unsubscribe();
    }
  });

  // The update card lives on this window, and a window brought back from the tray is a good moment
  // to check again if the last check is stale. See updater.ts.
  win.on("show", () => onMainWindowShown());
  win.webContents.once("did-finish-load", () => onMainWindowShown());

  // The signed-out prompt's view of the page: a full load starts over, and the grace period for the
  // web app to arm the sensor runs from the end of each load. Same-document navigations are the
  // SPA moving around and change nothing.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      signedOutMeetPrompt.pageLoadStarted();
      // The new page has no caption listener until it asks for the stream again.
      meetCaptionBuffer.unsubscribe();
    }
  });
  win.webContents.on("render-process-gone", () => meetCaptionBuffer.unsubscribe());
  win.webContents.on("did-finish-load", () => signedOutMeetPrompt.pageLoaded());

  // Minimize to tray instead of closing - except while quitting, when cancelling the close would
  // cancel the quit. See quit-lifecycle.ts.
  win.on("close", (event) => {
    if (shouldHideOnClose({ hasTray: tray !== null, isQuitting })) {
      event.preventDefault();
      win.hide();
    }
  });

  // Windows shutdown and log-off never emit `before-quit`, so the children stopped there (web
  // runtime, loopback capture, URL sensor) would be left to the OS. Routed through the same quit.
  win.on("session-end", () => app.quit());

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

    /**
     * `will-navigate` does not fire for a server-side 3xx.
     *
     * So a same-origin navigation could pass the check above, the server could answer 302 to
     * somewhere else, and the window would land there with this preload still attached — handing
     * `window.warptalk` to another origin without any script of ours running. Redirects off the
     * trusted origin are refused rather than followed; a legitimate one has never been needed.
     */
    win.webContents.on("will-redirect", (event, url) => {
      const targetOrigin = getUrlOrigin(url);
      if (targetOrigin === trustedOrigin) return;
      event.preventDefault();
      openExternalUrl(url);
    });

    win.webContents.on("did-navigate-in-page", (_event, url) => {
      if (isDesktopLandingUrl(url, trustedOrigin)) {
        reloadDesktopEntry();
      }
    });

    await win.loadURL(desktopEntryUrl);

    // A link that opened the app is only actionable now: the window exists and the trusted origin
    // it has to be resolved against is known.
    flushPendingPluginConnectLink();
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
/**
 * Says out loud that the bridge window has arrived.
 *
 * The window takes focus on purpose, but focus alone is a poor announcement: it can land while the
 * user is looking at another monitor, and a window that silently steals the keyboard is worse than
 * one that explains itself. The notification is the part that survives not looking.
 *
 * Clicking it brings the window forward, because a notification about a window that does not then
 * give you the window is a dead end. That includes a window the user has since closed: it used to
 * do nothing then, which is the dead end again. It brings back what the web app wants shown NOW
 * rather than what this notification announced, which may be twenty minutes and one meeting old.
 */
function announceBridgeWindow(): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title: "Your translated meeting is ready",
    body: "The transcript window is open beside your meeting.",
    icon: getDesktopAssetPath(APP_ICON_FILE),
  });

  notification.on("click", () => {
    const win = transcriptPanel.window;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    if (transcriptPanel.reopenTarget) {
      void reopenTranscriptWindow();
      return;
    }
    // Nothing is wanted any more - the meeting it announced is over. The app is the next best
    // answer to a click; nothing at all is the one answer that reads as broken.
    revealMainWindow();
  });

  notification.show();
}

/**
 * The signed-out prompt: the user is in a Google Meet call and nobody is signed in to WarpTalk.
 *
 * A notification and nothing more - no window raised, nothing focused. Clicking it shows the main
 * window, which is sitting on the login page; signing in is what arms the real bridge trigger.
 *
 * Held in a variable: on Windows a Notification that is garbage-collected loses its click handler.
 */
let signInNotification: Notification | null = null;

function announceSignInForMeet(): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title: "Translate this Google Meet call?",
    body: `Sign in to ${APP_NAME} to translate it and appear with your name.`,
    icon: getDesktopAssetPath(APP_ICON_FILE),
  });
  notification.on("click", () => revealMainWindow());
  notification.on("close", () => {
    if (signInNotification === notification) signInNotification = null;
  });
  signInNotification = notification;
  notification.show();
}

/**
 * Brings back the popup the user closed, on their say-so: the tray item, or a notification.
 *
 * Not announced - the user is the one who asked - and reported to the web app, whose trigger has
 * to adopt the window again or it would never close it when the meeting ends.
 */
async function reopenTranscriptWindow(): Promise<void> {
  const target = transcriptPanel.reopenTarget;
  if (!target) return;
  await openTranscriptWindow(target.roomId, { announce: false });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:transcript-window-reopened", target.roomId);
  }
}

/** Opens the popup on `roomId`'s transcript, or moves the open one there. */
async function openTranscriptWindow(
  roomId: string,
  { announce = true }: { announce?: boolean } = {},
): Promise<void> {
  if (!resolvedWebOrigin) {
    console.error("Cannot open the transcript window before the web UI has loaded.");
    return;
  }

  const target = `${resolvedWebOrigin}${TRANSCRIPT_ROUTE}/${encodeURIComponent(roomId)}`;

  const existing = transcriptPanel.window;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (announce) announceBridgeWindow();
    transcriptPanel.shown(existing, roomId);
    // Reusing the window is not the same as leaving it where it was: the web app moving from one
    // room to the next must not leave the popup showing the previous room's transcript.
    if (existing.webContents.getURL() !== target) {
      try {
        await existing.loadURL(target);
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
    /**
     * The window is meant to interrupt: it takes focus and announces itself, because a translated
     * meeting the user does not notice starting is a meeting they will think is broken. It opens
     * only for a real room the web app asked for, never on a sensor reading alone.
     */
    alwaysOnTop: true,
    show: false,
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
  transcriptPanel.shown(win, roomId);

  /**
   * Revealed on first paint, not after `loadURL` resolves.
   *
   * `show: false` keeps the user from seeing an empty frame while the panel loads; `ready-to-show`
   * fires once the renderer has something to draw, whichever load produced it — so the fallback
   * path is covered too, and a load that never settles cannot leave the window invisible forever.
   */
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    if (announce) announceBridgeWindow();
  });

  /**
   * The user closed it - the web app's own closes are withdrawn first and never reach this.
   *
   * The web app is told, because it is the one keeping a record of what is open. Silence here is
   * what lost the popup: the trigger went on believing it was up and skipped every later open for
   * the same meeting as a no-op.
   */
  win.on("closed", () => {
    const dismissed = transcriptPanel.closed(win);
    if (!dismissed) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:transcript-window-closed", dismissed.roomId);
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
  // Redirects are a separate event and were uncovered; this window carries the preload too.
  win.webContents.on("will-redirect", (event, url) => {
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
 * Aligns Hi-Fi Cable once at startup, when its two sides disagree and the inbound leg is silent.
 *
 * Only on a detected mismatch: a machine whose sides already agree, even at another rate, passes
 * sound and is left as the user set it. In the background, because it spawns PowerShell more than
 * once and nothing at startup should wait on that. See audio-device-format.ts for why this is not
 * left to the installer. The align it starts is the same single-flight one the IPC handler joins.
 */
async function alignHiFiCableFormatIfMismatched(): Promise<void> {
  try {
    const formats = await readHiFiCableFormats();
    if (!isHiFiFormatMismatch(formats)) return;
    const result = await alignHiFiCableFormat();
    if (result.ok) console.log("Aligned the Hi-Fi Cable endpoint formats:", JSON.stringify(result));
    else console.warn("Could not align the Hi-Fi Cable endpoint formats:", JSON.stringify(result));
  } catch (error) {
    console.warn("Could not check the Hi-Fi Cable endpoint formats:", error);
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
      message: "Install the Windows audio bridge cables",
      detail:
        "The bridge uses two free VB-Audio drivers, both on the same download page: VB-CABLE " +
        "carries your translated voice into the meeting, and Hi-Fi Cable carries the meeting back " +
        "to WarpTalk. Install both and restart if an installer asks.\n\n" +
        "Then, in Google Meet's audio settings, choose CABLE Output as the microphone and Hi-Fi " +
        "Cable Input as the speaker. WarpTalk sets both Hi-Fi Cable endpoints to the same format " +
        "when it starts; if the meeting stays silent, open Windows Sound settings and set BOTH Hi-Fi " +
        "Cable Input and Hi-Fi Cable Output to 24 bit, 48000 Hz. The cable passes no sound when " +
        "their sample rate or bit depth differ.\n\n" +
        "Without Hi-Fi Cable, WarpTalk still works but listens to your whole browser, so sound " +
        "from other tabs is translated too.\n\n" +
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

  // WarpTalk's own devices, when this build carries them (scripts/build-mac-audio-driver.sh). A build
  // without them falls through to the BlackHole instructions below, as every earlier release did.
  const bundledDrivers = getDesktopAssetPath("audio-drivers");
  if (MAC_BUNDLED_DRIVERS.every((bundle) => fs.existsSync(path.join(bundledDrivers, bundle)))) {
    return installBundledMacDrivers(bundledDrivers);
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
 * Adds WarpTalk's audio devices on launch when this Mac does not have them yet.
 *
 * A fresh download installs them already: the .pkg's postinstall copies them into the HAL
 * directory. This covers everyone who got the app another way - an auto-update from a version
 * that shipped without them (updates install from the .zip, which runs no scripts), or a pkg
 * install whose postinstall could not copy them. Asked once per app version, so "Not now" is
 * respected until the next update rather than repeated on every launch.
 */
async function ensureBundledMacDriversInstalled(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) return;

  const bundledDrivers = getDesktopAssetPath("audio-drivers");
  const carried = MAC_BUNDLED_DRIVERS.every((bundle) =>
    fs.existsSync(path.join(bundledDrivers, bundle)),
  );
  if (!carried) return;

  const installed = MAC_BUNDLED_DRIVERS.every((bundle) =>
    fs.existsSync(path.join("/Library/Audio/Plug-Ins/HAL", bundle)),
  );
  if (installed) return;

  const askedFlag = path.join(app.getPath("userData"), `audio-drivers-offered-${app.getVersion()}`);
  if (fs.existsSync(askedFlag)) return;
  try {
    fs.writeFileSync(askedFlag, new Date().toISOString());
  } catch {
    // Without the flag the offer may come back next launch, which is the lesser problem.
  }

  await installBundledMacDrivers(bundledDrivers);
}

/**
 * Installs WarpTalk Microphone and WarpTalk Speaker from the copies inside this app.
 *
 * The user agrees twice before anything privileged happens: once in this dialog, which says what
 * is about to be installed and where, and once in macOS's own password prompt.
 */
async function installBundledMacDrivers(
  sourceDirectory: string,
): Promise<{ started: boolean; reason?: string }> {
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: "Install WarpTalk's audio devices",
    detail:
      "An external meeting needs two virtual audio devices so Google Meet can send and receive " +
      'translated audio. WarpTalk adds them to this Mac as "WarpTalk Microphone" and "WarpTalk ' +
      'Speaker".\n\n' +
      "They install system-wide, so macOS asks for your administrator password. The devices " +
      "appear straight away, with no restart. To remove them later, delete the WarpTalk entries " +
      "from /Library/Audio/Plug-Ins/HAL.",
    buttons: ["Install", "Not now"],
    cancelId: 1,
    defaultId: 0,
  });
  if (response === 1) {
    return { started: false, reason: "declined" };
  }

  const script = buildMacDriverInstallScript(sourceDirectory);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn("osascript", ["-e", toAppleScriptAdminCommand(script)]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolve({ code: -1, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });

  if (result.code === 0) {
    return { started: true, reason: "installed" };
  }
  // -128 is AppleScript's "User canceled": the password prompt was dismissed, not a failure.
  if (/-128/.test(result.stderr)) {
    return { started: false, reason: "declined" };
  }
  dialog.showErrorBox(
    "WarpTalk could not install its audio devices",
    result.stderr.trim() || "The installer stopped without saying why.",
  );
  return { started: false, reason: "install-failed" };
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

  trayIcon = icon;
  if (process.platform === "win32") {
    const { width, height } = icon.getSize();
    const badged = nativeImage.createFromBitmap(withUpdateDot(icon.toBitmap(), width, height), { width, height });
    trayIconBadged = badged.isEmpty() ? null : badged;
  }
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();

  tray.on("double-click", () => {
    mainWindow?.show();
  });
}

/**
 * Rebuilt and set again rather than mutated in place: on Linux a tray menu changed after
 * `setContextMenu` is not repainted until it is set again, and one code path for every platform is
 * simpler than remembering which one needs it.
 */
function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuTemplate(
        APP_NAME,
        {
          meetingPanelAvailable: transcriptPanel.reopenTarget !== null,
          updateLabel: trayUpdateLabel(getUpdatePhase()),
        },
        {
          showApp: () => mainWindow?.show(),
          showMeetingPanel: () => void reopenTranscriptWindow(),
          checkForUpdates: () => void checkForUpdatesInteractive(),
          installUpdate: () => installUpdate(),
          quit: () => app.quit(),
        },
      ),
    ),
  );
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

      // A single-screen machine used to be granted the whole desktop with no prompt at all, which
      // is every laptop. Chromium only requires a transient user activation for getDisplayMedia,
      // and any click anywhere on the page supplies one — so the page could take the screen at a
      // moment of its choosing and nothing would appear on screen to say so. One screen still gets
      // a decision; it just has one option in it.
      if (sources.length === 1) {
        const { response: single } = await dialog.showMessageBox({
          type: "question",
          message: "Share your screen?",
          detail: `${APP_NAME} is asking to capture ${sources[0].name}.`,
          buttons: ["Share", "Cancel"],
          cancelId: 1,
          defaultId: 1,
        });
        callback(single === 0 ? { video: sources[0] } : {});
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
 * Permission requests, which nothing was answering.
 *
 * With no handler installed Electron approves whatever the page asks for, so the remote origin
 * could take the microphone and camera silently — no prompt, no indicator, no way for the user to
 * learn it had happened. That matters more here than in most apps, because this one sits running
 * beside the user's meetings all day.
 *
 * The allow-list is what the product actually uses: media for the meeting itself, notifications
 * for the realtime provider. Everything else — geolocation, clipboard reads, MIDI, serial, HID,
 * persistent storage prompts — is refused, because no part of WarpTalk asks for them and a page
 * that does is not behaving like WarpTalk.
 *
 * Origin is checked as well as permission. It cannot save a compromised trusted origin, but it
 * does mean a window that has somehow reached elsewhere gets nothing.
 */
const ALLOWED_PERMISSIONS = new Set(["media", "notifications"]);

function registerPermissionHandler(): void {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const requestOrigin = getUrlOrigin(contents.getURL());
    const trusted = resolvedWebOrigin !== null && requestOrigin === resolvedWebOrigin;
    callback(trusted && ALLOWED_PERMISSIONS.has(permission));
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

/**
 * A deep link that arrived before there was a window, or before the web origin was known.
 *
 * A cold start opens the app *because* of the link, so the link is in hand a second or two before
 * anything can act on it. Holding it is what makes the launched-by-link case behave like the
 * already-running one.
 */
let pendingPluginConnectLink: string | null = null;

function handlePluginConnectDeepLink(link: string): void {
  pendingPluginConnectLink = link;
  revealMainWindow();
  flushPendingPluginConnectLink();
}

function flushPendingPluginConnectLink(): void {
  if (!pendingPluginConnectLink) return;

  const target = pluginConnectTarget(pendingPluginConnectLink, resolvedWebOrigin);
  if (!target || !mainWindow || mainWindow.isDestroyed()) return;

  pendingPluginConnectLink = null;
  void mainWindow.loadURL(target).catch((error) => {
    console.error("Failed to open the plugins page after a connect:", error);
  });
}

/**
 * Claims the scheme with the OS.
 *
 * In development the executable is Electron itself, so the entry script has to be recorded
 * alongside it - registering `electron.exe` on its own points the scheme at a runtime with no app
 * to open.
 */
function registerPluginConnectScheme(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PLUGIN_CONNECT_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }

  app.setAsDefaultProtocolClient(PLUGIN_CONNECT_SCHEME);
}

/**
 * Whether installing an update now would cut a meeting short, so the update card asks first. Main
 * cannot see the web app's call state; these are the signs it has.
 */
function isMeetingActive(): boolean {
  const popup = transcriptPanel.window;
  if (popup && !popup.isDestroyed()) return true;
  if (loopbackCapturing) return true;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  try {
    return /\/rooms\/[^/]+\/live(\/|$|\?)/.test(new URL(win.webContents.getURL()).pathname);
  } catch {
    return false;
  }
}

function refreshTrayForUpdate(): void {
  refreshTrayMenu();
  if (!tray || !trayIcon) return;
  const phase = getUpdatePhase();
  tray.setToolTip(trayTooltip(APP_NAME, phase));
  tray.setImage(trayBadged(phase) && trayIconBadged ? trayIconBadged : trayIcon);
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
  // Windows and Linux deliver the link as an argument to the second launch, which the running
  // instance receives here rather than as an event of its own.
  app.on("second-instance", (_event, argv) => {
    const link = firstPluginConnectLink(argv);
    if (link) {
      handlePluginConnectDeepLink(link);
      return;
    }
    revealMainWindow();
  });

  // macOS never starts a second process for a scheme; it wakes this one with an event, which can
  // arrive before `whenReady`.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handlePluginConnectDeepLink(url);
  });

  app.whenReady().then(() => {
    registerPluginConnectScheme();
    applyApplicationMenu();
    registerIpcHandlers();
    registerDisplayMediaHandler();
    registerPermissionHandler();
    // Cold start: the scheme link is in argv on Windows and Linux, and `launchWindow` picks it up
    // once the window has loaded and the origin is known.
    const launchLink = firstPluginConnectLink(process.argv);
    if (launchLink) pendingPluginConnectLink = launchLink;

    launchWindow();
    createTray();
    initAutoUpdater({
      getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      revealMainWindow,
      isMeetingActive,
      onPhaseChange: refreshTrayForUpdate,
      iconPath: getDesktopAssetPath(APP_ICON_FILE),
    });
    void ensureBundledMacDriversInstalled();
    if (process.platform === "win32") void alignHiFiCableFormatIfMismatched();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        launchWindow();
      }
    });
  });

  app.on("before-quit", () => {
    // First, and before anything that could throw: this is what lets the windows close.
    isQuitting = true;
    webRuntime.stop();
    // Child processes this app started do not die with it on their own. The audit found the
    // loopback capture surviving both a renderer crash and quit; the URL sensor is a second such
    // child and is stopped here rather than repeating that.
    signedOutMeetPrompt.dispose();
    meetPresenceWatcher.disarm();
    meetUrlSensor.stop();
    meetCaptionStream.stop();
    meetCaptionSensor.stop();
    for (const contents of [...meetMicSubscribers.keys()]) unsubscribeMeetMic(contents);
    meetMicStream.stop();
    void windowsLoopbackRuntime.stop();
  });

  // Squirrel.Mac's quitAndInstall - which electron-updater's MacUpdater calls - closes every window
  // before it emits `before-quit`, so the flag would come too late. electron-updater emits this on
  // its Windows path as well, just before `app.quit()`.
  autoUpdater.on("before-quit-for-update", () => {
    isQuitting = true;
  });

  // Every window, the bridge popup included: a page's `beforeunload` silently cancels the quit in
  // Electron. See quit-lifecycle.ts shouldIgnoreBeforeUnload.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-prevent-unload", (event) => {
      if (shouldIgnoreBeforeUnload({ isQuitting })) event.preventDefault();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

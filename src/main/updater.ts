/**
 * The Electron shell updating itself (WT-618), and telling the user about it.
 *
 * WHY IN THE MAIN PROCESS, WITH SHELL-OWNED UI
 *   The renderer is a remote web app that ships on its own schedule. Update UI there would have to
 *   agree with whichever shell version happened to load it, and it would vanish exactly when an
 *   update matters most - when the web app fails to load. The card (update-card.ts), the Windows
 *   notification and the tray item depend on nothing but the shell.
 *
 * WHAT THE USER SEES
 *   The first version of this file said nothing until a 118 MB download had finished, then asked
 *   once in a dialog that could open behind Google Meet, and treated "Later" as "on the next Quit"
 *   in an app whose close button hides it to the tray. Users kept downloading releases by hand.
 *   Now:
 *     - available / downloading: a card in the main window with the progress, and one notification
 *       if the window is not in front;
 *     - ready: the card with Install and Later, one notification, a first tray item and a dot on the
 *       tray icon, all of which stay until the update is installed (Later hides only the card, for
 *       four hours);
 *     - Install: a silent install that reopens the app. Asked again first if a meeting is running.
 *   Check failures - offline, rate limited, DNS - are logged to updater.log and retried after
 *   fifteen minutes, never shown, except in answer to the tray's "Check for Updates…".
 *
 * WHY THE INSTALL IS SILENT
 *   `quitAndInstall()` with no arguments runs the NSIS installer with its UI. resources/installer.nsh
 *   installs the audio cables, behind a UAC prompt, on every install that is not silent - so each
 *   update looked exactly like reinstalling the app. `quitAndInstall(true, true)` passes /S and
 *   --force-run: no installer UI, no UAC, and the new version starts by itself.
 *
 * WHERE THE FEED COMES FROM
 *   Nowhere in this file for an installed build: both electron-builder configs carry a `publish:`
 *   github block, so the packaged app has resources/app-update.yml. scripts/check-release-contract.mjs
 *   fails CI if that block goes away. A portable copy has no app-update.yml and cannot install
 *   anything, so it is pointed at the same feed by hand and only ever told "a newer version exists".
 *
 * Decisions live in update-policy.ts, where they are tested; this file only carries them out.
 */

import { app, dialog, Notification, powerMonitor, shell, type BrowserWindow } from "electron";
import { autoUpdater, type UpdateCheckResult } from "electron-updater";
import path from "path";

import { UpdateCard } from "./update-card";
import {
  FIRST_CHECK_DELAY_MS,
  NO_DISMISSAL,
  RELEASES_PAGE_URL,
  dismissAfter,
  interactiveCheckDialog,
  nextCheckDelay,
  releaseNotesUrl,
  restartChoice,
  restartDialog,
  shouldCheckNow,
  summarizeUpdateError,
  toastFor,
  toastText,
  updateCardModel,
  updaterGate,
  type CardDismissal,
  type CheckReason,
  type InteractiveCheckOutcome,
  type UpdateCardAction,
  type UpdatePhase,
  type UpdaterGate,
} from "./update-policy";
import { createUpdaterLogger, type UpdaterLogger } from "./updater-log";

/** What the updater needs from the rest of the app. */
export interface UpdaterHost {
  getMainWindow(): BrowserWindow | null;
  /** Shows, restores and focuses the main window, creating it if needed. */
  revealMainWindow(): void;
  /** A bridge popup open, loopback capturing, or the main window in a live room. */
  isMeetingActive(): boolean;
  /** The tray reads getUpdatePhase(); this says it should. */
  onPhaseChange(): void;
  iconPath: string;
}

type Mode = "install" | "notify-only";

let logger: UpdaterLogger | null = null;
let gate: UpdaterGate | null = null;
let host: UpdaterHost | null = null;
let mode: Mode | null = null;
let interactiveCheck: Promise<void> | null = null;

let phase: UpdatePhase = { kind: "idle" };
let dismissal: CardDismissal = NO_DISMISSAL;
let confirmingInstall = false;
let lastCheckAt: number | null = null;
let checkRunning = false;
let scheduled: NodeJS.Timeout | null = null;
let snoozeTimer: NodeJS.Timeout | null = null;
const toastsShown = new Set<string>();
/** Kept referenced: a Notification collected by the GC loses its click handler on Windows. */
const liveToasts = new Set<Notification>();

const card = new UpdateCard((action) => handleCardAction(action));

function log(): UpdaterLogger {
  logger ??= createUpdaterLogger(path.join(app.getPath("logs"), "updater.log"));
  return logger;
}

function currentGate(): UpdaterGate {
  gate ??= updaterGate({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  return gate;
}

export function getUpdatePhase(): UpdatePhase {
  return phase;
}

/** Call once, after `app.whenReady()`. */
export function initAutoUpdater(appHost: UpdaterHost): void {
  if (mode) return;
  host = appHost;
  const decided = currentGate();
  log().info(`${app.getName()} ${app.getVersion()} on ${process.platform}/${process.arch}`);
  if (!decided.enabled && decided.code !== "portable") {
    log().info(`Auto-update skipped: ${decided.reason}`);
    return;
  }

  // Touched only past the gate: this getter constructs the platform updater on first access, and
  // on macOS that would be a MacUpdater no ad-hoc signed bundle can satisfy.
  autoUpdater.logger = log();
  // Releases ship the full NSIS installer, never the nsis-web stub. Refusing web-installer update
  // info closes a path nothing here uses; electron-updater warns on every download until it is set.
  autoUpdater.disableWebInstaller = true;

  if (decided.enabled) {
    mode = "install";
  } else {
    mode = "notify-only";
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({ provider: "github", owner: "WarpTalk-CapstoneProject", repo: "warptalk-desktop" });
    log().info(`Portable build: checking for new versions only (${decided.reason})`);
  }
  log().info(
    `Auto-update on (${mode}): autoDownload=${autoUpdater.autoDownload} autoInstallOnAppQuit=${autoUpdater.autoInstallOnAppQuit}`,
  );

  autoUpdater.on("update-available", (info) => {
    if (mode === "notify-only") {
      setPhase({ kind: "manual", version: info.version });
    } else if (phase.kind !== "ready" || phase.version !== info.version) {
      setPhase({ kind: "available", version: info.version });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (phase.kind === "available" || phase.kind === "manual") setPhase({ kind: "idle" });
  });
  autoUpdater.on("download-progress", (progress) => {
    const version = phase.kind === "available" || phase.kind === "downloading" ? phase.version : null;
    if (!version) return;
    const next: UpdatePhase = {
      kind: "downloading",
      version,
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    };
    // One repaint per whole percent is plenty; electron-updater reports far more often.
    if (phase.kind === "downloading" && Math.floor(phase.percent) === Math.floor(progress.percent)) {
      phase = next;
      return;
    }
    setPhase(next);
  });
  autoUpdater.on("update-downloaded", (event) => {
    log().info(`Update ${event.version} downloaded and ready to install`);
    setPhase({ kind: "ready", version: event.version });
  });
  // Log only. Every network failure arrives here; the retry is scheduled by runCheck.
  autoUpdater.on("error", (error) => {
    log().error(`Update error: ${summarizeUpdateError(error)}`);
    if (phase.kind === "available" || phase.kind === "downloading") {
      // The download failed after its check had already succeeded and booked the next one an hour
      // out; retry on the error schedule instead.
      setPhase({ kind: "idle" });
      if (!checkRunning) schedule(nextCheckDelay(true));
    }
  });

  powerMonitor.on("resume", () => triggerCheck("resume"));
  powerMonitor.on("unlock-screen", () => triggerCheck("unlock"));

  schedule(FIRST_CHECK_DELAY_MS);
}

/** index.ts calls this when the main window is shown or created. */
export function onMainWindowShown(): void {
  card.refresh(host?.getMainWindow() ?? null);
  triggerCheck("window-shown");
}

function schedule(delay: number): void {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    triggerCheck("scheduled");
  }, delay);
}

function triggerCheck(reason: CheckReason): void {
  if (!mode || checkRunning) return;
  if (!shouldCheckNow({ reason, phase, lastCheckAt, now: Date.now() })) {
    // A scheduled check skipped mid-download still has to come back later.
    if (reason === "scheduled") schedule(nextCheckDelay(false));
    return;
  }
  log().info(`Checking for updates (${reason})`);
  // A rejection has already been delivered to the `error` listener.
  runCheck().catch(() => {});
}

async function runCheck(): Promise<UpdateCheckResult | null> {
  checkRunning = true;
  let failed = false;
  try {
    const result = await autoUpdater.checkForUpdates();
    // The download runs on after the check resolves, and its failure is emitted as `error` too.
    // Unobserved, the same failure would also surface as an unhandled rejection.
    result?.downloadPromise?.catch(() => {});
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    checkRunning = false;
    lastCheckAt = Date.now();
    schedule(nextCheckDelay(failed));
  }
}

function setPhase(next: UpdatePhase): void {
  const changed = next.kind !== phase.kind || ("version" in next && "version" in phase && next.version !== phase.version);
  phase = next;
  if (next.kind !== "ready") confirmingInstall = false;
  render();
  if (changed) {
    maybeToast();
    host?.onPhaseChange();
  }
}

function render(): void {
  const win = host?.getMainWindow() ?? null;
  card.show(
    win,
    updateCardModel({ appName: app.getName(), phase, dismissal, now: Date.now(), confirmingInstall }),
  );
}

function windowInFront(): boolean {
  const win = host?.getMainWindow();
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
}

function maybeToast(): void {
  const decided = toastFor({ phase, alreadyShown: toastsShown, windowInFront: windowInFront() });
  if (!decided || !Notification.isSupported() || !("version" in phase)) return;
  toastsShown.add(decided.key);
  const text = toastText(app.getName(), decided.kind, phase.version);
  const toast = new Notification({ ...text, icon: host?.iconPath });
  liveToasts.add(toast);
  const release = (): void => void liveToasts.delete(toast);
  toast.on("close", release);
  toast.on("click", () => {
    release();
    if (decided.kind === "manual") {
      void shell.openExternal(RELEASES_PAGE_URL);
      return;
    }
    showCard();
  });
  toast.show();
}

/** Brings the main window forward with the card on it, un-snoozed. */
function showCard(): void {
  dismissal = NO_DISMISSAL;
  host?.revealMainWindow();
  render();
}

function handleCardAction(action: UpdateCardAction): void {
  const now = Date.now();
  switch (action) {
    case "install":
      if (host?.isMeetingActive()) {
        confirmingInstall = true;
        render();
        return;
      }
      installNow();
      return;
    case "confirm-install":
      installNow();
      return;
    case "cancel-install":
      confirmingInstall = false;
      render();
      return;
    case "notes":
      if ("version" in phase) void shell.openExternal(releaseNotesUrl(phase.version));
      return;
    case "download":
      void shell.openExternal(RELEASES_PAGE_URL);
      return;
    case "later":
    case "dismiss":
      dismissal = dismissAfter(action, phase, dismissal, now);
      confirmingInstall = false;
      log().info(`Update card: ${action} on ${phase.kind}`);
      render();
      if (snoozeTimer) clearTimeout(snoozeTimer);
      if (dismissal.snoozedUntil > now) {
        snoozeTimer = setTimeout(render, dismissal.snoozedUntil - now + 1000);
      }
      return;
  }
}

/** The tray's "Restart to update" item, the card's Install, and the ready dialog all end here. */
export function installUpdate(): void {
  if (phase.kind === "manual") {
    void shell.openExternal(RELEASES_PAGE_URL);
    return;
  }
  if (phase.kind !== "ready") return;
  if (host?.isMeetingActive()) {
    // Ask on the card, where the answer is visible next to the meeting it would end.
    confirmingInstall = true;
    showCard();
    return;
  }
  installNow();
}

function installNow(): void {
  if (phase.kind !== "ready") return;
  log().info(`Installing ${phase.version}: silent, relaunching afterwards`);
  // isSilent: /S, so installer.nsh skips the cable setup and its UAC prompt, and there is no
  // installer window. isForceRunAfter: --force-run, so the new version opens by itself.
  autoUpdater.quitAndInstall(true, true);
}

async function showOutcome(outcome: InteractiveCheckOutcome): Promise<void> {
  const { openReleasesButton, ...options } = interactiveCheckDialog(app.getName(), outcome);
  const { response } = await dialog.showMessageBox(options);
  if (openReleasesButton !== null && response === openReleasesButton) {
    await shell.openExternal(RELEASES_PAGE_URL);
  }
}

/**
 * The tray's "Check for Updates…". Always answers: up to date, downloading, ready to install,
 * could not check, or why this build does not update itself.
 */
export function checkForUpdatesInteractive(): Promise<void> {
  interactiveCheck ??= runInteractiveCheck()
    .catch((error) => log().error(`Interactive check failed: ${summarizeUpdateError(error)}`))
    .finally(() => {
      interactiveCheck = null;
    });
  return interactiveCheck;
}

async function runInteractiveCheck(): Promise<void> {
  const decided = currentGate();
  if (!decided.enabled) {
    log().info(`Check for Updates skipped: ${decided.reason}`);
    return showOutcome({ kind: "gated", gate: decided });
  }
  if (!mode) return; // initAutoUpdater has not run; nothing is wired to answer with.

  if (phase.kind === "ready") return answerReady(phase.version);
  if (phase.kind === "downloading" || phase.kind === "available") {
    showCard();
    return;
  }

  let result: UpdateCheckResult | null;
  try {
    result = await runCheck();
  } catch (error) {
    return showOutcome({ kind: "failed", error: summarizeUpdateError(error) });
  }
  if (!result?.isUpdateAvailable) {
    return showOutcome({ kind: "up-to-date", currentVersion: app.getVersion() });
  }
  // Available, downloading, or (from the cache) already ready: the card says which.
  showCard();
}

/** A ready build, asked about from the tray: the card if there is a window for it, else a dialog. */
async function answerReady(version: string): Promise<void> {
  if (host?.getMainWindow()) {
    showCard();
    return;
  }
  const { response } = await dialog.showMessageBox(restartDialog(app.getName(), version));
  if (restartChoice(response) === "restart") installUpdate();
}

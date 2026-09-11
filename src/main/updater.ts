/**
 * The Electron shell updating itself (WT-618).
 *
 * WHY IN THE MAIN PROCESS, WITH NATIVE UI
 *   The renderer is a remote web app that ships on its own schedule. Update UI there would have to
 *   agree with whichever shell version happened to load it, and it would vanish exactly when an
 *   update matters most - when the web app fails to load. A native dialog and a tray item depend on
 *   nothing but this file.
 *
 * WHAT THE USER SEES
 *   Nothing, until a newer build has finished downloading. electron-updater's defaults are kept on
 *   purpose: `autoDownload` fetches silently and `autoInstallOnAppQuit` installs on the next quit,
 *   so an update never interrupts a meeting to happen. The one interruption is a two-button dialog
 *   once the download is done, asked once per version, where Escape means Later.
 *   Failures - offline, rate limited, DNS - are logged to updater.log and never shown, except in
 *   answer to the tray's "Check for Updates…", where the user asked and is owed an answer.
 *
 * WHERE THE FEED COMES FROM
 *   Nowhere in this file. Both electron-builder configs carry a `publish:` github block, so the
 *   packaged app has resources/app-update.yml and electron-updater reads the latest GitHub release
 *   from it. scripts/check-release-contract.mjs fails CI if that block goes away.
 *
 * Decisions live in update-policy.ts, where they are tested; this file only carries them out.
 */

import { app, dialog, shell } from "electron";
import { autoUpdater, type UpdateCheckResult } from "electron-updater";
import path from "path";

import {
  FIRST_CHECK_DELAY_MS,
  RECHECK_INTERVAL_MS,
  RELEASES_PAGE_URL,
  interactiveCheckDialog,
  restartChoice,
  restartDialog,
  shouldPromptRestart,
  summarizeUpdateError,
  updaterGate,
  type InteractiveCheckOutcome,
  type UpdaterGate,
} from "./update-policy";
import { createUpdaterLogger, type UpdaterLogger } from "./updater-log";

let logger: UpdaterLogger | null = null;
let gate: UpdaterGate | null = null;
let active = false;
let interactiveCheck: Promise<void> | null = null;

const state = {
  /** Set from `update-available` until the download finishes or fails. */
  downloadingVersion: null as string | null,
  /** A build on disk, waiting for a restart or a quit. */
  downloadedVersion: null as string | null,
  lastPromptedVersion: null as string | null,
  dialogOpen: false,
};

function log(): UpdaterLogger {
  logger ??= createUpdaterLogger(path.join(app.getPath("logs"), "updater.log"));
  return logger;
}

function currentGate(): UpdaterGate {
  gate ??= updaterGate({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  return gate;
}

/** Call once, after `app.whenReady()`. */
export function initAutoUpdater(): void {
  if (active) return;
  const decided = currentGate();
  log().info(`${app.getName()} ${app.getVersion()} on ${process.platform}/${process.arch}`);
  if (!decided.enabled) {
    log().info(`Auto-update off: ${decided.reason}`);
    return;
  }
  active = true;

  // Touched only past the gate: this getter constructs the platform updater on first access, and
  // on macOS that would be a MacUpdater no ad-hoc signed bundle can satisfy.
  autoUpdater.logger = log();
  // Releases ship the full NSIS installer, never the nsis-web stub. Refusing web-installer update
  // info closes a path nothing here uses; electron-updater warns on every download until it is set.
  autoUpdater.disableWebInstaller = true;
  log().info(
    `Auto-update on: autoDownload=${autoUpdater.autoDownload} autoInstallOnAppQuit=${autoUpdater.autoInstallOnAppQuit}`,
  );

  autoUpdater.on("update-available", (info) => {
    state.downloadingVersion = info.version;
  });
  autoUpdater.on("update-downloaded", (event) => {
    state.downloadingVersion = null;
    state.downloadedVersion = event.version;
    void promptRestart(event.version, false);
  });
  // Log only. Every network failure arrives here, and a dialog for each one would be a dialog
  // every six hours for anyone on a flaky connection.
  autoUpdater.on("error", (error) => {
    state.downloadingVersion = null;
    log().error(`Update error: ${summarizeUpdateError(error)}`);
  });

  setTimeout(backgroundCheck, FIRST_CHECK_DELAY_MS);
  setInterval(backgroundCheck, RECHECK_INTERVAL_MS);
}

function backgroundCheck(): void {
  if (state.downloadingVersion) {
    log().info(`Skipping scheduled check: ${state.downloadingVersion} is still downloading`);
    return;
  }
  // A rejection has already been delivered to the `error` listener above.
  runCheck().catch(() => {});
}

async function runCheck(): Promise<UpdateCheckResult | null> {
  const result = await autoUpdater.checkForUpdates();
  // The download runs on after the check resolves, and its failure is emitted as `error` too.
  // Unobserved, the same failure would also surface as an unhandled rejection.
  result?.downloadPromise?.catch(() => {});
  return result;
}

async function promptRestart(version: string, userAsked: boolean): Promise<void> {
  if (
    !shouldPromptRestart({
      version,
      lastPromptedVersion: state.lastPromptedVersion,
      dialogOpen: state.dialogOpen,
      userAsked,
    })
  ) {
    return;
  }
  state.dialogOpen = true;
  state.lastPromptedVersion = version;
  try {
    log().info(`Asking to restart into ${version}`);
    const { response } = await dialog.showMessageBox(restartDialog(app.getName(), version));
    if (restartChoice(response) === "restart") {
      log().info(`Restart now: handing over to the ${version} installer`);
      autoUpdater.quitAndInstall();
    } else {
      log().info(`Later: ${version} will be installed on quit`);
    }
  } finally {
    state.dialogOpen = false;
  }
}

async function showOutcome(outcome: InteractiveCheckOutcome): Promise<void> {
  const { openReleasesButton, ...options } = interactiveCheckDialog(app.getName(), outcome);
  const { response } = await dialog.showMessageBox(options);
  if (openReleasesButton !== null && response === openReleasesButton) {
    await shell.openExternal(RELEASES_PAGE_URL);
  }
}

/**
 * The tray's "Check for Updates…". Always answers: up to date, downloading, ready to restart,
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
    log().info(`Check for Updates: off (${decided.reason})`);
    return showOutcome({ kind: "gated", gate: decided });
  }
  if (!active) return; // initAutoUpdater has not run; nothing is wired to answer with.

  if (state.downloadedVersion) return promptRestart(state.downloadedVersion, true);
  if (state.downloadingVersion) {
    return showOutcome({ kind: "downloading", version: state.downloadingVersion });
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

  // A build left in the cache by an earlier session "downloads" at once, and `update-downloaded`
  // has then already put the restart dialog up - saying "downloading" on top of it would be wrong.
  const version = result.updateInfo.version;
  const download = result.downloadPromise;
  const finishedAtOnce = download
    ? await Promise.race([
        download.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ])
    : false;
  if (finishedAtOnce || state.downloadedVersion === version) {
    return promptRestart(version, true);
  }
  return showOutcome({ kind: "downloading", version });
}

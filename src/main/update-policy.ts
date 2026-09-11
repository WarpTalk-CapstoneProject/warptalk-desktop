/**
 * What the self-updater decides, kept apart from what it does.
 *
 * updater.ts owns the side effects - the electron-updater singleton, timers, native dialogs - and
 * asks this file every question whose answer is a decision: may this build update itself at all,
 * should a finished download interrupt the user, what does a dialog say and what did its answer
 * mean. None of it imports Electron, so it runs under `node --test` like the rest of
 * src/main/__tests__.
 */

/** Where the manual path lives for builds that cannot update themselves. Public repo. */
export const RELEASES_PAGE_URL =
  "https://github.com/WarpTalk-CapstoneProject/warptalk-desktop/releases/latest";

/** First background check, after the window and the web app have had time to settle. */
export const FIRST_CHECK_DELAY_MS = 30_000;

/** Background re-check. Long enough to stay invisible against GitHub's anonymous rate limit. */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterGateCode = "not-packaged" | "portable" | "macos-unsigned" | "linux";

export type UpdaterGate =
  | { enabled: true }
  | {
      enabled: false;
      code: UpdaterGateCode;
      /** For updater.log. Says why, in terms a developer can act on. */
      reason: string;
      /** For the tray's "Check for Updates…". Says what the user can do instead. */
      userMessage: string;
    };

export interface UpdaterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

/**
 * Whether this build may update itself, and if not, why not.
 *
 * Every refusal names its reason because a silent updater is indistinguishable from a broken one:
 * the only evidence either leaves is an update that never arrived.
 */
export function updaterGate({ isPackaged, platform, env }: UpdaterEnvironment): UpdaterGate {
  if (!isPackaged) {
    return {
      enabled: false,
      code: "not-packaged",
      reason: "app is not packaged (dev run); there is no app-update.yml to read",
      userMessage: "Updates are only checked in installed builds. This is a development run.",
    };
  }

  // electron-builder's portable launcher sets this before starting the real executable. A portable
  // copy is a single .exe the user put somewhere by hand; the NSIS installer electron-updater would
  // run installs a second, separate copy rather than replacing this one.
  if (env.PORTABLE_EXECUTABLE_DIR) {
    return {
      enabled: false,
      code: "portable",
      reason: `portable build (PORTABLE_EXECUTABLE_DIR=${env.PORTABLE_EXECUTABLE_DIR}); the NSIS installer would not replace it`,
      userMessage:
        "This is the portable version of WarpTalk, which does not update itself. " +
        "Download the latest version, or use the installer to get automatic updates.",
    };
  }

  // Squirrel.Mac refuses to apply an update whose signature it cannot tie to a Developer ID, and
  // the bundle is ad-hoc signed until one is bought (WT-618 T7). Gated off rather than left to
  // fail: it would download 100+ MB and then error at install time, every six hours.
  if (platform === "darwin") {
    return {
      enabled: false,
      code: "macos-unsigned",
      reason: "macOS build is ad-hoc signed; Squirrel.Mac rejects updates without a Developer ID (WT-618 T7)",
      userMessage:
        "Automatic updates are not available on macOS yet. Download the latest version to update.",
    };
  }

  // The .deb updater needs root through pkexec, and the AppImage path has never been exercised.
  // Manual until someone owns testing it.
  if (platform === "linux") {
    return {
      enabled: false,
      code: "linux",
      reason: "Linux self-update is not enabled (deb needs root; AppImage untested)",
      userMessage:
        "Automatic updates are not available on Linux yet. Download the latest version to update.",
    };
  }

  return { enabled: true };
}

/**
 * Whether a finished download should put the restart dialog in front of the user.
 *
 * electron-updater emits `update-downloaded` again for a build it already has cached, which means
 * every six-hourly check after a "Later" would ask again - in the middle of whatever meeting is
 * running at the time. One ask per version, unless the user went looking for it from the tray.
 */
export function shouldPromptRestart(input: {
  version: string;
  lastPromptedVersion: string | null;
  dialogOpen: boolean;
  userAsked: boolean;
}): boolean {
  if (input.dialogOpen) return false;
  if (input.userAsked) return true;
  return input.version !== input.lastPromptedVersion;
}

export interface MessageBoxSpec {
  type: "info" | "question" | "warning";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /**
   * Always true. Without it Electron on Windows renders any button it does not recognise as a
   * standard one ("Restart now", "Later") as a stacked command link - a full-width tile per choice
   * - instead of the two ordinary buttons a quick yes/no-later question calls for.
   */
  noLink: true;
}

const RESTART_NOW = 0;
const LATER = 1;

export function restartDialog(appName: string, version: string): MessageBoxSpec {
  return {
    type: "info",
    title: `${appName} update`,
    message: `${appName} ${version} is ready to install.`,
    detail:
      `Restart now to finish updating, or choose Later and it will be installed the next time you quit ${appName}.`,
    buttons: ["Restart now", "Later"],
    defaultId: RESTART_NOW,
    // Escape and the window's close button mean Later, never Restart: dismissing a dialog must not
    // end the user's meeting.
    cancelId: LATER,
    noLink: true,
  };
}

export function restartChoice(response: number): "restart" | "later" {
  return response === RESTART_NOW ? "restart" : "later";
}

/** What the user asked about, and what the updater knew when they asked. */
export type InteractiveCheckOutcome =
  | { kind: "gated"; gate: Extract<UpdaterGate, { enabled: false }> }
  | { kind: "up-to-date"; currentVersion: string }
  | { kind: "downloading"; version: string }
  | { kind: "failed"; error: string };

/**
 * The feedback dialog for the tray's "Check for Updates…". A download that already finished is
 * not here: that answer is the restart dialog itself.
 *
 * `openReleasesButton` marks the button (if any) that should open RELEASES_PAGE_URL - offered only
 * where the manual download is the actual way forward.
 */
export function interactiveCheckDialog(
  appName: string,
  outcome: InteractiveCheckOutcome,
): MessageBoxSpec & { openReleasesButton: number | null } {
  switch (outcome.kind) {
    case "up-to-date":
      return {
        type: "info",
        title: `${appName} update`,
        message: `${appName} is up to date (v${outcome.currentVersion}).`,
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        openReleasesButton: null,
      };
    case "downloading":
      return {
        type: "info",
        title: `${appName} update`,
        message: `${appName} ${outcome.version} is downloading.`,
        detail: "You will be asked to restart when it is ready. You can keep working in the meantime.",
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        openReleasesButton: null,
      };
    case "failed":
      return {
        type: "warning",
        title: `${appName} update`,
        message: "Could not check for updates.",
        detail: `Check your internet connection and try again.\n\n${outcome.error}`,
        buttons: ["OK", "Open download page"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        openReleasesButton: 1,
      };
    case "gated": {
      // A dev run has no download page to send anyone to.
      const manual = outcome.gate.code !== "not-packaged";
      return {
        type: "info",
        title: `${appName} update`,
        message: outcome.gate.userMessage,
        buttons: manual ? ["OK", "Open download page"] : ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        openReleasesButton: manual ? 1 : null,
      };
    }
  }
}

/** Error messages from the network stack can carry a full stack and response body. One line. */
export function summarizeUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

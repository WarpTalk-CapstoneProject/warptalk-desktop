/**
 * What the self-updater decides, kept apart from what it does.
 *
 * updater.ts owns the side effects - the electron-updater singleton, timers, the update card,
 * notifications, dialogs - and asks this file every question whose answer is a decision: may this
 * build update itself at all, when to check, what the card and the tray say, when to notify, what
 * a click on the card means. None of it imports Electron, so it runs under `node --test` like the rest of
 * src/main/__tests__.
 */

/** Where the manual path lives for builds that cannot update themselves. Public repo. */
export const RELEASES_PAGE_URL =
  "https://github.com/WarpTalk-CapstoneProject/warptalk-desktop/releases/latest";

/** First background check, once the window has started loading and before the user settles in. */
export const FIRST_CHECK_DELAY_MS = 10_000;

/**
 * Background re-check. Hourly, where it used to be every six hours: a release went out, and a user
 * who had the app open all afternoon heard nothing and downloaded it by hand. electron-updater's
 * GitHub provider reads releases.atom and latest.yml as plain downloads, not the REST API, so the
 * anonymous 60-requests-an-hour API limit does not apply to it.
 */
export const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/** After a failed check (offline, DNS, a dropped download). Six hours was a long time to be offline. */
export const RETRY_AFTER_ERROR_MS = 15 * 60 * 1000;

/** Showing the window checks again if the last check is at least this old. */
export const STALE_CHECK_MS = 30 * 60 * 1000;

/** How long "Later" hides the update card. The tray item and its badge stay regardless. */
export const LATER_SNOOZE_MS = 4 * 60 * 60 * 1000;

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
      reason: "unsigned build (macOS, ad-hoc signed); Squirrel.Mac rejects updates without a Developer ID (WT-618 T7)",
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

/**
 * The tray's "Check for Updates…" once a build is ready and the update card cannot be shown (no
 * main window). Everywhere else the card is the answer.
 */
export function restartDialog(appName: string, version: string): MessageBoxSpec {
  return {
    type: "info",
    title: `${appName} update`,
    message: `${appName} ${version} is ready to install.`,
    detail: `${appName} will close for a few seconds and reopen. Choose Later and it will be installed the next time you quit ${appName}.`,
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
        detail: `The ${appName} window shows its progress, and an Install button when it is ready. You can keep working in the meantime.`,
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

/**
 * Where the update is, as the user should see it.
 *
 * `manual` is a build that cannot install updates itself - a portable copy, or macOS and Linux
 * until they can (WT-674): the feed says there is a newer build, and the only way to it is the
 * download page.
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number; transferred: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "manual"; version: string; why: ManualUpdateReason };

export type ManualUpdateReason = "portable" | "macos" | "linux";

/** What the user has done to the card this session. Forgotten on relaunch, on purpose. */
export interface CardDismissal {
  /** ✕ on "available" / "downloading": hidden until that version is ready. */
  hiddenUntilReadyVersion: string | null;
  /** "Later" on "ready", or ✕ on "manual": hidden for that version until `snoozedUntil`. */
  snoozedVersion: string | null;
  snoozedUntil: number;
}

export const NO_DISMISSAL: CardDismissal = {
  hiddenUntilReadyVersion: null,
  snoozedVersion: null,
  snoozedUntil: 0,
};

export type UpdateCardAction =
  | "install"
  | "confirm-install"
  | "cancel-install"
  | "later"
  | "dismiss"
  | "download"
  | "notes";

export const UPDATE_CARD_ACTIONS: readonly UpdateCardAction[] = [
  "install",
  "confirm-install",
  "cancel-install",
  "later",
  "dismiss",
  "download",
  "notes",
];

export interface UpdateCardButton {
  action: UpdateCardAction;
  label: string;
  style: "primary" | "secondary" | "danger";
}

export interface UpdateCardModel {
  title: string;
  detail: string;
  /** 0-100 while downloading, otherwise null. */
  progress: number | null;
  buttons: UpdateCardButton[];
  /** Shows the ✕ in the corner. */
  dismissible: boolean;
  /** Shows "What's new", which opens the release page for this version. */
  notes: boolean;
}

function megabytes(bytes: number): string {
  return String(Math.max(0, Math.round(bytes / (1024 * 1024))));
}

const MANUAL_DETAIL: Record<ManualUpdateReason, string> = {
  portable: "This portable copy can't update itself. Download the installer to get automatic updates.",
  macos: "Download the new installer and open it to update. Automatic updates are coming to macOS.",
  linux: "Download the new package and install it to update.",
};

function isSnoozed(dismissal: CardDismissal, version: string, now: number): boolean {
  return dismissal.snoozedVersion === version && now < dismissal.snoozedUntil;
}

/**
 * The card in the main window's corner, or null for no card.
 *
 * WHY A CARD AND NOT THE OLD DIALOG
 *   The dialog came once per version, only after the download finished, with no parent window, so
 *   it could open behind Google Meet. Miss it or press Later and the only remaining path was a Quit
 *   the app is built to avoid (closing the window hides it to the tray). Users downloaded every
 *   release by hand instead. The card says there is an update the moment the feed does, shows the
 *   download, and stays until the update is installed, apart from an explicit Later.
 */
export function updateCardModel(input: {
  appName: string;
  phase: UpdatePhase;
  dismissal: CardDismissal;
  now: number;
  /** The user pressed Install while a meeting was running; ask before ending it. */
  confirmingInstall: boolean;
}): UpdateCardModel | null {
  const { appName, phase, dismissal, now } = input;
  switch (phase.kind) {
    case "idle":
      return null;
    case "available":
      if (dismissal.hiddenUntilReadyVersion === phase.version) return null;
      return {
        title: `${appName} ${phase.version} is available`,
        detail: "Downloading in the background. You can keep working.",
        progress: null,
        buttons: [],
        dismissible: true,
        notes: true,
      };
    case "downloading": {
      if (dismissal.hiddenUntilReadyVersion === phase.version) return null;
      const percent = Math.max(0, Math.min(100, Math.floor(phase.percent)));
      return {
        title: `Downloading ${appName} ${phase.version}`,
        detail:
          phase.total > 0
            ? `${percent}% · ${megabytes(phase.transferred)} of ${megabytes(phase.total)} MB`
            : `${percent}%`,
        progress: percent,
        buttons: [],
        dismissible: true,
        notes: true,
      };
    }
    case "ready":
      if (isSnoozed(dismissal, phase.version, now)) return null;
      if (input.confirmingInstall) {
        return {
          title: "Install now and leave the meeting?",
          detail: `Translation stops while ${appName} restarts. It takes about 10 seconds.`,
          progress: null,
          buttons: [
            { action: "cancel-install", label: "Not now", style: "secondary" },
            { action: "confirm-install", label: "Install anyway", style: "danger" },
          ],
          dismissible: false,
          notes: false,
        };
      }
      return {
        title: `${appName} ${phase.version} is ready to install`,
        detail: `${appName} will close for a few seconds and reopen.`,
        progress: null,
        buttons: [
          { action: "later", label: "Later", style: "secondary" },
          { action: "install", label: "Install", style: "primary" },
        ],
        dismissible: false,
        notes: true,
      };
    case "manual":
      if (isSnoozed(dismissal, phase.version, now)) return null;
      return {
        title: `${appName} ${phase.version} is available`,
        detail: MANUAL_DETAIL[phase.why],
        progress: null,
        buttons: [{ action: "download", label: "Download", style: "primary" }],
        dismissible: true,
        notes: false,
      };
  }
}

/** What a click on the card does to the dismissal record. Other actions leave it unchanged. */
export function dismissAfter(
  action: UpdateCardAction,
  phase: UpdatePhase,
  dismissal: CardDismissal,
  now: number,
): CardDismissal {
  if (phase.kind === "idle") return dismissal;
  if (action === "dismiss" && (phase.kind === "available" || phase.kind === "downloading")) {
    return { ...dismissal, hiddenUntilReadyVersion: phase.version };
  }
  if (action === "later" || (action === "dismiss" && phase.kind === "manual")) {
    return { ...dismissal, snoozedVersion: phase.version, snoozedUntil: now + LATER_SNOOZE_MS };
  }
  return dismissal;
}

export type UpdateToastKind = "available" | "ready" | "manual";

/**
 * Whether a phase change deserves a Windows notification.
 *
 * Once per version per kind: electron-updater re-emits update-downloaded for a cached build on
 * every check, and an hourly toast would be noise. And only when the card would not be seen - the
 * window hidden in the tray or behind another app, which during a bridge meeting is the usual case.
 */
export function toastFor(input: {
  phase: UpdatePhase;
  alreadyShown: ReadonlySet<string>;
  windowInFront: boolean;
}): { kind: UpdateToastKind; key: string } | null {
  const { phase } = input;
  if (phase.kind !== "available" && phase.kind !== "ready" && phase.kind !== "manual") return null;
  if (input.windowInFront) return null;
  const key = `${phase.kind}:${phase.version}`;
  return input.alreadyShown.has(key) ? null : { kind: phase.kind, key };
}

export function toastText(
  appName: string,
  kind: UpdateToastKind,
  version: string,
): { title: string; body: string } {
  switch (kind) {
    case "available":
      return { title: `${appName} ${version} is available`, body: "Downloading in the background." };
    case "ready":
      return {
        title: `${appName} ${version} is ready to install`,
        body: `Click to install it. ${appName} will reopen by itself.`,
      };
    case "manual":
      return { title: `${appName} ${version} is available`, body: "Click to download the new version." };
  }
}

export type CheckReason = "scheduled" | "resume" | "unlock" | "window-shown";

/**
 * Whether a trigger other than the user should run a check now.
 *
 * Waking from sleep and unlocking always check: timers do not run while the machine sleeps, and a
 * laptop that sleeps every night would otherwise go most of a day between checks. Showing the
 * window checks only when the last check is stale, since users bring it up many times a day.
 * Nothing checks while a download is running or a build is waiting to be installed.
 */
export function shouldCheckNow(input: {
  reason: CheckReason;
  phase: UpdatePhase;
  lastCheckAt: number | null;
  now: number;
}): boolean {
  if (input.phase.kind === "downloading" || input.phase.kind === "ready") return false;
  if (input.reason !== "window-shown") return true;
  return input.lastCheckAt === null || input.now - input.lastCheckAt >= STALE_CHECK_MS;
}

/** When the next scheduled check runs, from how the last one went. */
export function nextCheckDelay(lastCheckFailed: boolean): number {
  return lastCheckFailed ? RETRY_AFTER_ERROR_MS : RECHECK_INTERVAL_MS;
}

/** The tray's first item while an update waits on the user. Null means no such item. */
export function trayUpdateLabel(phase: UpdatePhase): string | null {
  if (phase.kind === "ready") return `Restart to update (${phase.version})`;
  if (phase.kind === "manual") return `Download ${phase.version}…`;
  return null;
}

export function trayTooltip(appName: string, phase: UpdatePhase): string {
  if (phase.kind === "ready") return `${appName} - update ${phase.version} is ready to install`;
  if (phase.kind === "downloading") return `${appName} - downloading update ${phase.version}`;
  if (phase.kind === "manual") return `${appName} - ${phase.version} is available`;
  return appName;
}

/** Whether the tray icon carries the "an update is waiting" dot. */
export function trayBadged(phase: UpdatePhase): boolean {
  return phase.kind === "ready" || phase.kind === "manual";
}

/** The release page for one version, for "What's new". */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/WarpTalk-CapstoneProject/warptalk-desktop/releases/tag/v${version}`;
}

/**
 * The card's buttons navigate to `warptalk-update:<action>`; the main process cancels the
 * navigation and acts on it. That keeps the card page without a preload or any IPC surface. Anything
 * that is not exactly one of the known actions is ignored.
 */
export const UPDATE_CARD_SCHEME = "warptalk-update:";

export function parseCardAction(url: string): UpdateCardAction | null {
  if (!url.startsWith(UPDATE_CARD_SCHEME)) return null;
  const action = url.slice(UPDATE_CARD_SCHEME.length);
  return (UPDATE_CARD_ACTIONS as readonly string[]).includes(action) ? (action as UpdateCardAction) : null;
}

/**
 * Which builds are told about new versions without installing them, and which feed file tells them.
 *
 * These never touch electron-updater: on macOS its getter constructs a MacUpdater, and Squirrel.Mac
 * cannot be trusted on an ad-hoc signed bundle (see updaterGate). Reading the feed file electron-
 * builder already publishes next to every release needs nothing but an HTTPS GET.
 */
export function notifyOnlyFeed(gate: UpdaterGate): { why: ManualUpdateReason; file: string } | null {
  if (gate.enabled) return null;
  switch (gate.code) {
    case "portable":
      return { why: "portable", file: "latest.yml" };
    case "macos-unsigned":
      return { why: "macos", file: "latest-mac.yml" };
    case "linux":
      return { why: "linux", file: "latest-linux.yml" };
    case "not-packaged":
      return null;
  }
}

/** The feed file of the newest non-draft release, via GitHub's own redirect. */
export function notifyOnlyFeedUrl(file: string): string {
  return `https://github.com/WarpTalk-CapstoneProject/warptalk-desktop/releases/latest/download/${file}`;
}

/** `version:` from an electron-builder latest*.yml. Null when there is none. */
export function parseFeedVersion(yml: string): string | null {
  const match = /^version:\s*['"]?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)['"]?\s*$/m.exec(yml);
  return match ? match[1] : null;
}

/**
 * Whether `candidate` is a newer release than `current`. Major.minor.patch only; a prerelease of the
 * same version counts as older, and anything unparsable as not newer - a wrong "update available"
 * is worse than a missed one, since the missed one is caught at the next check.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], boolean] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])], m[4] !== undefined] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[0][i] !== b[0][i]) return a[0][i] > b[0][i];
  }
  return !a[1] && b[1];
}

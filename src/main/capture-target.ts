/**
 * Aiming the loopback capture at the browser that is showing Google Meet, and letting it go when
 * that browser stops showing it.
 *
 * WHY NOT THE PICKER
 *   The web app used to choose the window to capture from `listWindowsLoopbackSources`, by a title
 *   heuristic (`likelyMeetingWindow`). A window title is written by the page, so any tab could win
 *   it. Main already knows the answer from a source a page cannot forge: the browser process behind
 *   the current Meet sighting (meet-presence.ts reads the browser's own URL). `target:
 *   "meet-sighting"` asks main to use that instead. Every other start gate still runs afterwards —
 *   this only fills in `targetProcessId`.
 *
 * WHY THE STOP IS OPT-IN AND SLOW
 *   A capture started this way can also ask main to stop it once Meet is gone (`stopWhenMeetGone`).
 *   Older renderers do not ask and keep today's behaviour: the capture runs until they stop it.
 *
 *   "Gone" has to survive the user looking away. Switching from the Meet tab ends the sighting
 *   before Chrome's automatic picture-in-picture starts the next one, and the watcher only looks
 *   every 3 s; the web trigger covers that gap with OFFER_GRACE_MS = 8 s (warptalk-web
 *   bridge-trigger.ts). That is the right size for an offer, which costs nothing to raise again.
 *   It is the wrong size here: a stopped capture is a translation that silently ends while the user
 *   is still in the call — a tab switch with auto-PiP off, a slow PiP, a quick look at another tab.
 *   So the grace is far longer (MEET_GONE_GRACE_MS) and the asymmetry is deliberate: a capture
 *   that outlives the call by a minute costs a minute of silence; one cut short costs the meeting.
 */

import type {
  AudioCaptureState,
  CaptureStartedVia,
  WindowsLoopbackCaptureRequest,
  WindowsLoopbackStartResult,
} from "../shared/types.ts";

export type { CaptureStartedVia };

/** What main knows about the current Meet sighting, read off MeetPresenceWatcher. */
export interface MeetSightingSnapshot {
  /** The watcher is polling at all. Disarmed means "not looking", never "Meet is gone". */
  armed: boolean;
  /** The last poll saw a Meet window (document or picture-in-picture). */
  visible: boolean;
  /** The browser process behind that sighting. Null on macOS, whose sensor cannot name one. */
  processId: number | null;
}

export type MeetSightingResolution =
  | { ok: true; processId: number }
  | { ok: false; reason: "meet-sighting-missing" | "meet-sighting-no-process" };

/**
 * The PID to capture for `target: "meet-sighting"`, or why there is none.
 *
 * Two failures, kept apart because they mean different things to whoever reads the log: "missing"
 * is no Meet on screen (or nobody looking), "no-process" is a Meet the platform cannot attribute to
 * a process. Both send the web app back to its picker.
 */
export function resolveMeetSightingTarget(sighting: MeetSightingSnapshot): MeetSightingResolution {
  if (!sighting.armed || !sighting.visible) return { ok: false, reason: "meet-sighting-missing" };
  const pid = sighting.processId;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: "meet-sighting-no-process" };
  }
  return { ok: true, processId: pid };
}

/**
 * How long Meet may be out of sight before main stops a capture that asked to be stopped then.
 *
 * 60 s: 7.5x the web trigger's 8 s offer grace and twenty sensor polls. Long enough for a PiP
 * hand-off, a slow PiP, and a look at another tab without PiP; short enough that a call that ended
 * does not keep the browser's audio (whatever plays next in it) flowing into the room for long.
 */
export const MEET_GONE_GRACE_MS = 60_000;

export interface MeetGoneCaptureGuardOptions {
  /** Stop the capture. Called at most once per `begin`. */
  onGone: () => void;
  /**
   * Whether the watcher is still looking, asked when the grace runs out. A watcher disarmed in the
   * meantime saw nothing either way, and "could not look" must never stop a capture.
   */
  isWatching: () => boolean;
  graceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Stops a capture once the Meet sighting it was aimed by has been gone for the whole grace.
 *
 * Fed by the watcher's change events only. A sighting coming back — any Meet window, a PiP
 * included — cancels the countdown; a read that FAILED never reaches here (the watcher keeps its
 * last observation), so a flaky sensor cannot end a meeting.
 */
export class MeetGoneCaptureGuard {
  private active = false;
  private timer: unknown = null;
  private readonly options: MeetGoneCaptureGuardOptions;

  constructor(options: MeetGoneCaptureGuardOptions) {
    this.options = options;
  }

  get watching(): boolean {
    return this.active;
  }

  get pending(): boolean {
    return this.timer !== null;
  }

  /** A capture that asked for it has started. It was aimed by a live sighting, so none is pending. */
  begin(): void {
    this.cancel();
    this.active = true;
  }

  /** The capture stopped for any other reason. */
  end(): void {
    this.cancel();
    this.active = false;
  }

  observe(presence: { meetWindowVisible: boolean }): void {
    if (!this.active) return;
    if (presence.meetWindowVisible) {
      this.cancel();
      return;
    }
    // Counted from the FIRST report of absence; a second "not visible" does not restart it.
    if (this.timer !== null) return;
    const setTimer = this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      if (!this.active || !this.options.isWatching()) return;
      this.active = false;
      this.options.onGone();
    }, this.options.graceMs ?? MEET_GONE_GRACE_MS);
  }

  private cancel(): void {
    if (this.timer === null) return;
    const clearTimer = this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.timer);
    this.timer = null;
  }
}

/** Sends one event to every live window in the list. Destroyed or missing ones are skipped. */
export function sendToWindows(
  windows: ReadonlyArray<{ isDestroyed(): boolean; webContents: { send(channel: string, ...args: unknown[]): void } } | null | undefined>,
  channel: string,
  ...args: unknown[]
): number {
  let sent = 0;
  const seen = new Set<unknown>();
  for (const win of windows) {
    if (!win || seen.has(win) || win.isDestroyed()) continue;
    seen.add(win);
    win.webContents.send(channel, ...args);
    sent += 1;
  }
  return sent;
}

export interface PreparedCaptureRequest {
  ok: true;
  request: WindowsLoopbackCaptureRequest;
  startedVia: CaptureStartedVia;
  stopWhenMeetGone: boolean;
}

/**
 * Turns the renderer's start request into the one the runtime gates.
 *
 * With `target: "meet-sighting"` the sighting's PID replaces whatever window or PID came along —
 * the point of the target is that the renderer does not get to choose. Without it the request is
 * passed through untouched. `stopWhenMeetGone` only means something for a sighting-aimed capture:
 * a picked window has no sighting to lose.
 */
export function prepareCaptureRequest(
  raw: unknown,
  sighting: MeetSightingSnapshot,
): PreparedCaptureRequest | Extract<WindowsLoopbackStartResult, { started: false }> {
  const request: WindowsLoopbackCaptureRequest =
    raw && typeof raw === "object" ? { ...(raw as WindowsLoopbackCaptureRequest) } : {};
  const target = request.target;
  const stopWhenMeetGone = request.stopWhenMeetGone === true;
  delete request.target;
  delete request.stopWhenMeetGone;

  if (target !== "meet-sighting") {
    return {
      ok: true,
      request,
      startedVia: Number.isInteger(request.targetProcessId) ? "process-id" : "source",
      stopWhenMeetGone: false,
    };
  }

  const resolved = resolveMeetSightingTarget(sighting);
  if (!resolved.ok) return { started: false, riskId: "R8", reason: resolved.reason };
  delete request.sourceId;
  request.targetProcessId = resolved.processId;
  return { ok: true, request, startedVia: "meet-sighting", stopWhenMeetGone };
}

/** The `audio:get-capture-state` answer. Nothing but `capturing: false` while nothing runs. */
export function captureStateOf(input: {
  capturing: boolean;
  mode: "voice" | "text-only" | null;
  targetProcessId: number | null;
  startedVia: CaptureStartedVia | null;
}): AudioCaptureState {
  if (!input.capturing) return { capturing: false, mode: null, targetProcessId: null, startedVia: null };
  return {
    capturing: true,
    mode: input.mode,
    targetProcessId: input.targetProcessId,
    startedVia: input.startedVia,
  };
}

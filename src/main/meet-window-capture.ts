/**
 * Handing the Google Meet window to the main window's `getDisplayMedia`, once, without a picker,
 * so a bridge meeting can be recorded with Meet's own UI in the picture (WT-910).
 *
 * WHY A RECORDING NEEDS THIS AT ALL
 *   Google Meet refuses to record for most accounts, and the bridge meeting lives in Meet, not in a
 *   WarpTalk room. The web main window records it the way native meetings are recorded: it
 *   publishes a video track into the WarpTalk LiveKit room and the existing RoomComposite egress
 *   writes it out. The track has to come from somewhere, and the only honest picture of "the
 *   meeting" is the browser window Meet is in.
 *
 * WHY NO PICKER
 *   Every other `getDisplayMedia` in this app gets a dialog (index.ts, registerDisplayMediaHandler),
 *   because Chromium only wants a transient user activation and any click supplies one. A picker
 *   here would be worse than useless: the user would have to find their Meet window by title in a
 *   list, at the moment they are trying to join a call, and the title is page-written anyway. The
 *   decision was already made — the popup's listen-consent panel has a "Record this meeting"
 *   checkbox (default on, opt-out) — and main already knows which window Meet is in from a source a
 *   page cannot forge (meet-presence.ts: the HWND the URL sensor read the address bar from).
 *
 * WHY AN EXPLICIT ARM, AND WHY SO NARROW
 *   Skipping the dialog is only acceptable for the request the user opted into, so it is not a mode
 *   but a one-shot: the main window asks main to arm (`bridge:arm-meet-window-capture`), and the
 *   NEXT getDisplayMedia from that same webContents within ARM_TTL_MS is answered with the sighted
 *   window, video only. One use, then gone; unused, it expires. Anything else — another window, a
 *   second request, the Present button a minute later — gets today's dialog exactly as before.
 *   Arming also requires the loopback capture to be running: that capture only starts with the
 *   user's listen consent (windows-loopback-runtime.ts, R5), and it is the only consent main holds.
 *   Main has no per-room consent store and this does not invent one.
 *
 * WHY HWND AND NOT THE TITLE
 *   Electron names a window source `window:<HWND>:0`; the sensor read the address bar of exactly one
 *   HWND. Matching on that is exact. Matching on the title would hand the recording to whichever
 *   window wrote the right words into `document.title` — the reason meet-presence.ts stopped
 *   trusting titles in the first place — so there is deliberately no title fallback: no HWND, no
 *   recording (`meet-window-not-found`), and the web app records without the window.
 *
 * PICTURE-IN-PICTURE AND OTHER TABS (B18, PO decision 2026-10-02)
 *   The PiP window is never recorded: while Meet shows there, or the call-state tracker says the
 *   call is in PiP, an arm is refused with `meet-not-on-tab`. A window capture shows what the window
 *   shows, so a granted capture of the browser window would show another tab after a tab switch;
 *   the web app stops publishing the track while Meet is off its tab (`watchMeetCall`) and arms
 *   again when the tab is back. Arming is repeatable for that reason: each arm replaces the last,
 *   and only the first grant for a room announces the recording.
 *   macOS has no HWND and no sensor PID; it answers `unsupported-platform`.
 *
 * A MEET TAB MOVED TO ANOTHER WINDOW (2026-10-03)
 *   Dragging the Meet tab out of its window gives the call a new HWND, and a granted capture keeps
 *   recording the old window, which now shows some other tab. The call state carries the HWND the
 *   call was read from (`MeetCallState.windowHandle`) and a granted arm answers with the HWND it
 *   will hand out (`windowHandle` on the result), so the web app sees the two differ and arms
 *   again. The arm takes the call-state tracker's window first (meetWindowHandleForArm), because
 *   right after a drag the presence sighting still names the old one.
 */

import type { ArmMeetWindowCaptureResult } from "../shared/types.ts";
import { parseDesktopSourceWindowHandle } from "./windows-loopback-sources.ts";

/** How long an arm waits for its getDisplayMedia. The web app calls it straight after arming. */
export const MEET_WINDOW_CAPTURE_ARM_TTL_MS = 10_000;

export type ArmMeetWindowCaptureRefusal = Extract<ArmMeetWindowCaptureResult, { ok: false }>["reason"];

/**
 * Whether an arm request may go any further, before anything is enumerated. Null means yes.
 *
 * The order is the order of the questions a reader of the log would ask: can this platform do it,
 * is the right window asking, and did the user agree to the meeting being listened to at all.
 */
export function armPreconditionRefusal(input: {
  platform: string;
  fromMainWindow: boolean;
  roomId: unknown;
  /** The loopback capture is running, which it only does with the user's listen consent. */
  consentedCaptureRunning: boolean;
}): ArmMeetWindowCaptureRefusal | null {
  if (input.platform !== "win32") return "unsupported-platform";
  if (!input.fromMainWindow) return "not-main-window";
  // A request that names no room cannot be the one the user opted into for a room.
  if (typeof input.roomId !== "string" || input.roomId.trim().length === 0) return "consent-required";
  if (!input.consentedCaptureRunning) return "consent-required";
  return null;
}

/** What main knows about the current Meet sighting, read off MeetPresenceWatcher. */
export interface MeetWindowSightingSnapshot {
  armed: boolean;
  visible: boolean;
  windowHandle: number | null;
  /**
   * Meet is showing in Chrome's picture-in-picture window: the last sighting came from it, or the
   * call-state tracker places the call there. Optional so older callers read as "not known".
   */
  inPictureInPicture?: boolean;
}

export type MeetWindowSourceResolution<S> =
  | { ok: true; source: S }
  | { ok: false; reason: "meet-sighting-missing" | "meet-window-not-found" | "meet-not-on-tab" };

/**
 * The window source that is the sighted Meet window, matched by HWND and nothing else.
 *
 * "missing" is no Meet on screen (or nobody looking); "not-found" is a Meet main saw but cannot
 * pin to a capturable window — no HWND from the sensor, or the window is gone from the list.
 */
export function resolveMeetWindowSource<S extends { id: string }>(
  sighting: MeetWindowSightingSnapshot,
  sources: ReadonlyArray<S>,
): MeetWindowSourceResolution<S> {
  if (!sighting.armed || !sighting.visible) return { ok: false, reason: "meet-sighting-missing" };
  // B18: the PiP window is never recorded, whatever its handle.
  if (sighting.inPictureInPicture === true) return { ok: false, reason: "meet-not-on-tab" };
  const handle = sighting.windowHandle;
  if (typeof handle !== "number" || !Number.isSafeInteger(handle) || handle <= 0) {
    return { ok: false, reason: "meet-window-not-found" };
  }
  const source = sources.find((candidate) => parseDesktopSourceWindowHandle(candidate.id) === handle);
  return source ? { ok: true, source } : { ok: false, reason: "meet-window-not-found" };
}

export interface MeetWindowCaptureGrant<S> {
  source: S;
  roomId: string;
  /** The first grant for this room in this app session, for a one-time "Recording" notice. */
  firstForRoom: boolean;
}

/**
 * The one-shot itself. Pure state and a clock passed in, so the tests drive the 10 s by hand.
 *
 * Holds at most one arm: a second arm replaces the first rather than queueing, because the web app
 * only ever wants the latest one and a queue of dialog-free grants is exactly what this must not be.
 */
export class MeetWindowCaptureArm<S> {
  private current: { webContentsId: number; source: S; roomId: string; expiresAtMs: number } | null = null;
  private readonly announcedRooms = new Set<string>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = MEET_WINDOW_CAPTURE_ARM_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Whether an unexpired arm is waiting, as of `nowMs`. */
  isArmed(nowMs: number): boolean {
    return this.current !== null && nowMs < this.current.expiresAtMs;
  }

  arm(input: { webContentsId: number; source: S; roomId: string }, nowMs: number): void {
    this.current = { ...input, expiresAtMs: nowMs + this.ttlMs };
  }

  /**
   * Answers one getDisplayMedia, or null for "not ours — use the normal handler".
   *
   * A request from any other webContents does not consume the arm: the popup or a stray frame must
   * not be able to burn the main window's grant, nor receive it. An expired arm is dropped here.
   */
  take(webContentsId: number, nowMs: number): MeetWindowCaptureGrant<S> | null {
    const current = this.current;
    if (!current) return null;
    if (nowMs >= current.expiresAtMs) {
      this.current = null;
      return null;
    }
    if (current.webContentsId !== webContentsId) return null;
    this.current = null;
    const firstForRoom = !this.announcedRooms.has(current.roomId);
    this.announcedRooms.add(current.roomId);
    return { source: current.source, roomId: current.roomId, firstForRoom };
  }

  /** The capture the arm leaned on stopped, so its consent no longer holds. */
  disarm(): void {
    this.current = null;
  }
}

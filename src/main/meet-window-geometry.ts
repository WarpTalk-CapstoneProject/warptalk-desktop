/**
 * Where the Google Meet page sits inside its browser window, so a bridge recording can show the
 * meeting and not the browser around it (WT-910 follow-up).
 *
 * THE BUG (production recording, 2026-10-03)
 *   The Meet window capture is a capture of the whole Chrome window: the tab strip with the titles
 *   of every other open tab, the address bar, the bookmarks bar. That is not "the Google Meet UI"
 *   the recording promises, and the other tabs' titles are the user's business, not the meeting's.
 *
 * WHAT THIS DOES
 *   The URL sensor's helper already holds the page's Document element for every Meet tab it reads
 *   (meet-url-sensor.ts, Read-Window). Its bounding rectangle is the web contents' viewport: below
 *   the tab strip, the address bar, the bookmarks bar and any infobar, beside a side panel or docked
 *   DevTools. The helper now also reads the window's own rectangles and sends all of them, raw
 *   (`MEET_SURFACE_SCRIPT`, Get-MeetGeometry). This file turns them into `MeetWindowGeometry`,
 *   relative to the visible window, and refuses anything that does not add up. The web app crops
 *   the captured frames to `content` (warptalk-web lib/meeting/meet-window-crop.ts); it is the only
 *   side that knows the size of the frames the capture actually delivers.
 *
 * WHY THREE WINDOW RECTANGLES
 *   GetWindowRect includes the invisible resize borders (about 7-8 px left, right and bottom on
 *   Windows 10/11, hanging off-screen on a maximized window); DWMWA_EXTENDED_FRAME_BOUNDS is the
 *   visible window. Which one a Windows Graphics Capture frame covers was not measured, so both
 *   are sent and the web side picks the one whose shape matches the frame. UI Automation's own
 *   rectangle for the window is the cross-check that all of them are in one coordinate space: the
 *   helper asks to be per-monitor DPI aware, but if Windows refused, GetWindowRect would come back
 *   scaled to 96 DPI while DWM and UI Automation answer in physical pixels — a crop computed from
 *   that would cut the meeting itself. Sizes that disagree by more than a few pixels drop the
 *   geometry, and the recording stays uncropped, which is what it was before this file.
 *
 * RELATIVE, NOT ABSOLUTE
 *   Moving the window must not produce a new call state every second (the tracker emits on change),
 *   so everything is relative to the visible window's top-left. Only a layout change — bookmarks bar
 *   toggled, window resized, fullscreen entered or left — gives a new value.
 */

import type { MeetCallState, MeetWindowGeometry, MeetWindowRect } from "../shared/types.ts";
import { isWindowHandle } from "./window-handle.ts";

interface Ltrb {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Larger than any virtual desktop; a value past it is garbage, not a monitor arrangement. */
const COORDINATE_LIMIT = 100_000;
/** Windows parks a minimized window's rectangle at (-32000, -32000). */
const MINIMIZED_PARKING = -30_000;
/** A visible Meet window is never smaller than this; anything smaller is not worth cropping. */
const MIN_FRAME_WIDTH = 200;
const MIN_FRAME_HEIGHT = 150;
/** How far the Document may poke past the visible window (rounding of a fractional DPI). */
const CONTENT_TOLERANCE_PX = 2;
/**
 * How far UI Automation's window size may differ from GetWindowRect's or DWM's. A DPI mismatch at
 * the smallest scaling step (125%) is 20% of the size, far beyond this; the borders are ~16 px.
 */
const SPACE_TOLERANCE_PX = 24;

function ltrb(input: unknown): Ltrb | null {
  // Windows PowerShell 5.1 can serialise an array that went through the pipeline wrapped as
  // {"value": [...], "Count": n}; accept that shape too rather than lose the geometry to it.
  const raw =
    input && typeof input === "object" && !Array.isArray(input) && Array.isArray((input as { value?: unknown }).value)
      ? (input as { value: unknown[] }).value
      : input;
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const values: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT) return null;
    values.push(Math.round(value));
  }
  const [l, t, r, b] = values;
  if (r <= l || b <= t) return null;
  return { l, t, r, b };
}

function inside(inner: Ltrb, outer: Ltrb, tolerance: number): boolean {
  return (
    inner.l >= outer.l - tolerance &&
    inner.t >= outer.t - tolerance &&
    inner.r <= outer.r + tolerance &&
    inner.b <= outer.b + tolerance
  );
}

function sameSize(a: Ltrb, b: Ltrb, tolerance: number): boolean {
  return Math.abs(a.r - a.l - (b.r - b.l)) <= tolerance && Math.abs(a.b - a.t - (b.b - b.t)) <= tolerance;
}

function relativeTo(origin: Ltrb, rect: Ltrb): MeetWindowRect {
  return { x: rect.l - origin.l, y: rect.t - origin.t, width: rect.r - rect.l, height: rect.b - rect.t };
}

/**
 * The helper's raw `geometry` for one Meet tab, as `MeetWindowGeometry`, or null.
 *
 * Raw shape (screen pixels, `[left, top, right, bottom]`): `win` GetWindowRect, `efb` DWM extended
 * frame bounds (may be null: DWM off or the call failed, then `win` stands in), `uia` UI Automation's
 * rectangle for the window (may be null), `doc` the Document element. Null for anything malformed,
 * a minimized window, coordinate spaces that disagree, or a Document outside the visible window.
 */
export function parseMeetWindowGeometry(raw: unknown): MeetWindowGeometry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const win = ltrb(item.win);
  const doc = ltrb(item.doc);
  if (!win || !doc) return null;
  if (win.l <= MINIMIZED_PARKING || win.t <= MINIMIZED_PARKING) return null;
  const efb = ltrb(item.efb) ?? win;
  // The visible window is part of the window. Not so means the two answers are in different
  // coordinate spaces (GetWindowRect DPI-virtualised, DWM physical).
  if (!inside(efb, win, 1)) return null;
  const uia = ltrb(item.uia);
  if (uia && !sameSize(uia, win, SPACE_TOLERANCE_PX) && !sameSize(uia, efb, SPACE_TOLERANCE_PX)) return null;
  // Against the VISIBLE window, not GetWindowRect: the page can never be in the invisible resize
  // borders, and the web side crops within `frame`. A pixel or two past it (fractional DPI
  // rounding) is clamped back in, so `content` is always inside `frame`.
  if (!inside(doc, efb, CONTENT_TOLERANCE_PX)) return null;
  if (efb.r - efb.l < MIN_FRAME_WIDTH || efb.b - efb.t < MIN_FRAME_HEIGHT) return null;
  const content: Ltrb = {
    l: Math.max(doc.l, efb.l),
    t: Math.max(doc.t, efb.t),
    r: Math.min(doc.r, efb.r),
    b: Math.min(doc.b, efb.b),
  };
  return {
    frame: relativeTo(efb, efb),
    window: relativeTo(efb, win),
    content: relativeTo(efb, content),
  };
}

function sameRect(a: MeetWindowRect, b: MeetWindowRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Equality for the tracker's emit-on-change. Both absent is equal. */
export function sameMeetWindowGeometry(
  a: MeetWindowGeometry | null | undefined,
  b: MeetWindowGeometry | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return sameRect(a.frame, b.frame) && sameRect(a.window, b.window) && sameRect(a.content, b.content);
}

/** How recent the call-state tracker's latest read must be for an arm to lean on it. */
export const CALL_READ_FRESH_MS = 5_000;

export interface MeetWindowForArm {
  /** The window to capture; null when nobody named one. */
  windowHandle: number | null;
  /** Meet is in Chrome's picture-in-picture window: the arm is refused (B18). */
  inPictureInPicture: boolean;
  /**
   * The committed in-call state is being doubted: the tracker's latest reading says something else
   * (`unknown` or `left` awaiting confirmation). The arm is refused like PiP (`meet-not-on-tab`) and
   * the web app arms again once the state has settled.
   */
  unsettled: boolean;
  /** Which source answered, for the log line. */
  source: "call-state" | "presence";
}

/** The tracker's newest reading (MeetCallStateTracker.latestReading), before confirmation. */
export interface MeetLatestCallReading {
  phase: MeetCallState["phase"];
  via: MeetCallState["via"];
  windowHandle?: number;
  /** Date.now() when the read came back. */
  atMs: number;
}

/**
 * Which window an arm captures, and whether Meet is in PiP — both from ONE source, so the HWND and
 * the PiP gate can never disagree about which read they came from.
 *
 *   call-state  the tracker's committed reading is `in-call`, and its LATEST reading is at most
 *               CALL_READ_FRESH_MS old and agrees with it (phase, tab/PiP, window). On the tab, with
 *               a handle: that window, not PiP. In PiP: refused. The tracker reads every second;
 *               right after the Meet tab is dragged into a new window — or out of PiP back onto a
 *               tab — it already names the new state while presence (every 3 s) may still name the
 *               old one.
 *   unsettled   the committed reading is `in-call` but the latest fresh one disagrees: `unknown` or
 *               `left` are only committed after ~2 s of confirmation, and meanwhile the window may
 *               already show another tab. Refused; presence is no help here, as it may be the same
 *               age as the committed state or older. Freshness is the latest reading's, never "the
 *               last read" alone - a read that disagrees is not evidence for the state it doubts.
 *   presence    anything else (lobby, `unknown`, a stale tracker, no handle): the presence sighting,
 *               which the tracker's own reads also refresh (MeetPresenceWatcher.noteWindow). A
 *               tracker that last said PiP still refuses: B18 never records the PiP window, and a
 *               stale "not PiP" is not evidence enough to override it.
 */
export function meetWindowForArm(input: {
  sighting: { windowHandle: number | null; via: "document" | "pip" | null };
  call: Pick<MeetCallState, "phase" | "via" | "windowHandle">;
  /** The tracker's latest reading; null when it has none. */
  latest: MeetLatestCallReading | null;
  nowMs: number;
}): MeetWindowForArm {
  const { sighting, call, latest } = input;
  const fresh = latest !== null && input.nowMs - latest.atMs <= CALL_READ_FRESH_MS;
  if (fresh && call.phase === "in-call") {
    const agrees =
      latest.phase === call.phase &&
      latest.via === call.via &&
      (latest.windowHandle ?? null) === (call.windowHandle ?? null);
    if (!agrees) return { windowHandle: null, inPictureInPicture: false, unsettled: true, source: "call-state" };
    if (call.via === "pip") {
      return { windowHandle: sighting.windowHandle, inPictureInPicture: true, unsettled: false, source: "call-state" };
    }
    if (call.via === "tab" && isWindowHandle(call.windowHandle)) {
      return { windowHandle: call.windowHandle, inPictureInPicture: false, unsettled: false, source: "call-state" };
    }
  }
  return {
    windowHandle: isWindowHandle(sighting.windowHandle) ? sighting.windowHandle : null,
    inPictureInPicture: sighting.via === "pip" || call.via === "pip",
    unsettled: false,
    source: "presence",
  };
}

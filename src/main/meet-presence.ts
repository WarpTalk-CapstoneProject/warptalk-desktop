/**
 * Noticing that a Google Meet call is on screen, without anything installed in the browser.
 *
 * This used to match window titles, and that was wrong in a way no amount of tightening fixes:
 * Chrome names its window after `document.title`, so the string being matched is written by the
 * page — any tab could claim to be a meeting. The sensor now reads the browser's own URL through
 * UI Automation (see meet-url-sensor.ts); a page cannot write the address it is served from.
 *
 * WHAT THIS IS NOT
 *   It is a sensor, not a decision. It reports what it saw and nothing else: no lead time, no
 *   latch to stop the widget flickering when the user switches tabs, no opinion about which
 *   meeting the title belongs to. All of that is policy, it is testable without a desktop build,
 *   and it lives on the web side next to the other pure decision (`bridge-tiers.ts`). Putting the
 *   latch here would bury the one rule most likely to need tuning inside the one process hardest
 *   to test.
 *
 * WHAT IT COSTS
 *   A helper process holding a warm UI Automation client, and one read per poll across the
 *   browser windows on the machine. Measured on the target machine: 9-55 ms per window read, and
 *   sustained polling costs about 0.2 points of one core — the real cost is a one-time
 *   accessibility wake-up in the browser rather than anything per read, and the delta vanished
 *   across six paired idle/polling rounds.
 *
 *   It runs for the whole signed-in session on the desktop, for every user, including those who
 *   never open a bridge meeting: the web app's bridge trigger arms it whenever the app shell is
 *   up. Signed out, main arms it itself, only to offer a sign-in (signed-out-meet-prompt.ts). If
 *   that price should be optional, the gate belongs in a user preference, not in an accident of
 *   which rooms happen to exist.
 */

import type { MeetPresence } from "../shared/types.ts";
import type { MeetSighting } from "./meet-url-sensor.ts";

export interface MeetPresenceWatcherOptions {
  /**
   * One look at the machine. Resolves to null for "no Meet window" and REJECTS for "could not
   * look" — the two must stay distinguishable, because only one of them should close a widget.
   * Injected so the tests need neither Electron nor a browser.
   */
  readMeetSighting: () => Promise<MeetSighting | null>;
  /** Called only when the observation actually changed, never once per tick. */
  onChange: (presence: MeetPresence) => void;
  intervalMs?: number;
  now?: () => number;
}

/** Slow enough not to matter, fast enough that the widget does not feel late. */
const DEFAULT_INTERVAL_MS = 3000;

export class MeetPresenceWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: MeetPresence | null = null;
  private polling = false;
  /**
   * The browser process behind the last sighting.
   *
   * Deliberately not part of `MeetPresence`, so it never crosses IPC. The renderer has no use for
   * a process id, and the audit of `listWindowsLoopbackSources` showed what happens when main
   * hands the renderer more of the machine than it needs. Capture targeting reads it here.
   */
  private lastProcessId: number | null = null;
  /**
   * The HWND behind the last sighting, for the same reason and with the same rule as
   * `lastProcessId`: main-process only, never part of `MeetPresence`. Recording the meeting
   * (meet-window-capture.ts) reads it to pick the window source without a picker.
   */
  private lastWindowHandle: number | null = null;
  /** Which read the last sighting came from: a normal tab ("document") or Chrome's PiP window. */
  private lastVia: "document" | "pip" | null = null;

  private readonly options: MeetPresenceWatcherOptions;

  constructor(options: MeetPresenceWatcherOptions) {
    this.options = options;
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  /** The browser process the last sighting belonged to, for aiming capture. Main-process only. */
  get meetProcessId(): number | null {
    return this.lastProcessId;
  }

  /** The window the last sighting was read from, for window capture. Main-process only. */
  get meetWindowHandle(): number | null {
    return this.lastWindowHandle;
  }

  /** Whether the last sighting was Chrome's picture-in-picture window rather than the Meet tab. */
  get meetWindowVia(): "document" | "pip" | null {
    return this.lastVia;
  }

  /** Whether the last poll saw a Meet window. False while disarmed or before the first answer. */
  get meetWindowVisible(): boolean {
    return this.last?.meetWindowVisible === true;
  }

  /**
   * A fresher read of WHERE Meet is, from the call-state tracker's 1 s `state` scan: the window,
   * the browser process and whether it is the PiP window - all three from this one read, so the
   * process can never belong to another window than the HWND - nothing else. Visibility and the room code stay with the 3 s poll
   * (and so does `onChange`), so this never opens or closes a widget. Without it the window capture
   * would be armed against a sighting up to 3 s old - right after the Meet tab is dragged out of
   * PiP or into a new window, the wrong window or a stale PiP refusal (WT-910).
   * Ignored while disarmed, before the first sighting, and for a read that saw no Meet.
   */
  noteWindow(sighting: MeetSighting | null): void {
    if (!this.timer || !sighting || this.last?.meetWindowVisible !== true) return;
    this.lastWindowHandle = sighting.windowHandle ?? null;
    this.lastProcessId = sighting.processId ?? null;
    this.lastVia = sighting.via;
  }

  /** Idempotent: arming an armed watcher keeps the one interval it already has. */
  arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    // Answer the first question immediately. Waiting a full interval to say what is already on
    // screen is the difference between a widget that appears and one the user beats to it.
    void this.poll();
  }

  disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Forgotten on purpose, so the next arm reports what it sees rather than comparing against an
    // observation from a previous meeting and staying silent because nothing "changed".
    this.last = null;
    this.lastProcessId = null;
    this.lastWindowHandle = null;
    this.lastVia = null;
    this.polling = false;
  }

  private async poll(): Promise<void> {
    // One enumeration at a time. A slow platform call must not queue up behind itself and turn a
    // 3 second interval into an unbounded backlog of shell work.
    if (this.polling) return;
    this.polling = true;

    let sighting: MeetSighting | null;
    try {
      sighting = await this.options.readMeetSighting();
    } catch {
      // Keep the last observation rather than reporting the meeting gone. A read that failed says
      // nothing about whether the user is still in the call, and reporting `false` here would
      // close a widget over a transient error.
      this.polling = false;
      return;
    }
    this.polling = false;

    // Disarmed while the enumeration was in flight: that answer belongs to a session nobody is
    // listening to any more.
    if (!this.timer) return;

    const presence: MeetPresence = {
      meetWindowVisible: sighting !== null,
      observedAtMs: (this.options.now ?? Date.now)(),
    };
    // Absent from a picture-in-picture window, which exposes the host without the path. That is
    // why the field is optional and why nothing downstream may require it to believe a sighting.
    if (sighting?.meetCode) presence.meetCode = sighting.meetCode;
    this.lastProcessId = sighting?.processId ?? null;
    this.lastWindowHandle = sighting?.windowHandle ?? null;
    this.lastVia = sighting?.via ?? null;

    if (
      this.last &&
      this.last.meetWindowVisible === presence.meetWindowVisible &&
      this.last.meetCode === presence.meetCode
    ) {
      return;
    }

    this.last = presence;
    this.options.onChange(presence);
  }
}

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
 *   It runs for the whole session on the desktop, for every user, including those who never open
 *   a bridge meeting. That is deliberate and it is the price of the feature: the sensor used to
 *   arm only where a bridge room already existed, which meant the very first bridge meeting a
 *   workspace ever had could never be offered — the one case the offer exists for. If that price
 *   should be optional, the gate belongs in a user preference, not in an accident of which rooms
 *   happen to exist.
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

  /**
   * The Meet room code of the call on screen, when the last sighting carried one.
   *
   * Read by the offer window, so the room it creates can store the call's own link: without it an
   * impromptu bridge room could never be told apart from another Meet call, and the schedule never
   * showed it as a Google Meet meeting.
   */
  get meetCode(): string | null {
    return this.last?.meetWindowVisible ? (this.last.meetCode ?? null) : null;
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

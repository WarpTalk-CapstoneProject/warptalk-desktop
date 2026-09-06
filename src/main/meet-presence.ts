/**
 * Noticing that a Google Meet call is on screen, without anything installed in the browser.
 *
 * The desktop app cannot see tabs. What it can see is window titles, which Electron already hands
 * over for the loopback picker — so "is the user in a Meet right now" is answerable today, for
 * every browser, with no extension and no new permission. That is the whole reason this file is
 * cheaper than it looks.
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
 *   `desktopCapturer.getSources` enumerates every window on the machine. With `thumbnailSize` at
 *   zero it does not capture pixels, but it is still not free, so it runs only while armed. The
 *   renderer arms it when a bridge meeting is near and disarms when that stops being true; nothing
 *   polls in the background on the chance a meeting might happen.
 */

import type { MeetPresence } from "../shared/types.ts";
import { isMeetWindowTitle, extractMeetCode } from "./windows-loopback-sources.ts";

export interface MeetPresenceWatcherOptions {
  /** Window titles, as the platform reports them. Injected so the tests need no Electron. */
  listWindowTitles: () => Promise<string[]>;
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

  private readonly options: MeetPresenceWatcherOptions;

  constructor(options: MeetPresenceWatcherOptions) {
    this.options = options;
  }

  get armed(): boolean {
    return this.timer !== null;
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
    this.polling = false;
  }

  private async poll(): Promise<void> {
    // One enumeration at a time. A slow platform call must not queue up behind itself and turn a
    // 3 second interval into an unbounded backlog of shell work.
    if (this.polling) return;
    this.polling = true;

    let titles: string[];
    try {
      titles = await this.options.listWindowTitles();
    } catch {
      // Keep the last observation rather than reporting the meeting gone. An enumeration that
      // failed says nothing about whether the user is still in the call, and reporting `false`
      // here would close a widget over a transient error.
      this.polling = false;
      return;
    }
    this.polling = false;

    // Disarmed while the enumeration was in flight: that answer belongs to a session nobody is
    // listening to any more.
    if (!this.timer) return;

    const meetTitle = titles.find((title) => isMeetWindowTitle(title));
    const presence: MeetPresence = {
      meetWindowVisible: Boolean(meetTitle),
      observedAtMs: (this.options.now ?? Date.now)(),
    };
    const code = meetTitle ? extractMeetCode(meetTitle) : null;
    if (code) presence.meetCode = code;

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

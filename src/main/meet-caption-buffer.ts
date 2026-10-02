import type { MeetCaptionEvent, MeetCaptionStatus } from "../shared/types.ts";

/**
 * Holds Meet caption events while no renderer is listening, so a hint is not lost to a reload.
 * Every event leaves through here stamped with `sentAtMs` (see `deliver`).
 *
 * The transport is UIA (main) -> hidden main window (renderer, owns the hub connection) -> gateway
 * hub -> Redis. Main reads captions whether or not that renderer is there to take them: the window
 * may still be loading, reloading after a crash or a web deploy, or the web app may not have
 * called `setMeetCaptionsStream` yet. `webContents.send` to a page that is not listening drops the
 * message silently, so main keeps the last `maxAgeMs` (30 s) of events and hands them over, oldest
 * first, when a renderer (re)subscribes. Older than that a name hint is no longer worth matching:
 * the web side's speaker attribution has moved on.
 *
 * "Subscribed" means: the main window's renderer asked for the stream (`setMeetCaptionsStream`
 * enabled) and has not navigated, reloaded or gone away since. Main cannot see `ipcRenderer.on`
 * listeners, so the enable call is the subscription.
 */
export class MeetCaptionBuffer {
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly send: (event: MeetCaptionEvent) => void;
  private readonly sendStatus: (status: MeetCaptionStatus) => void;
  private queue: { at: number; event: MeetCaptionEvent }[] = [];
  private lastStatus: MeetCaptionStatus | null = null;
  private subscribed = false;

  constructor(options: {
    send: (event: MeetCaptionEvent) => void;
    sendStatus: (status: MeetCaptionStatus) => void;
    now?: () => number;
    maxAgeMs?: number;
  }) {
    this.send = options.send;
    this.sendStatus = options.sendStatus;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 30_000;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  /** Buffered events, oldest first. For tests and diagnostics. */
  get pending(): readonly MeetCaptionEvent[] {
    this.prune();
    return this.queue.map((entry) => entry.event);
  }

  event(event: MeetCaptionEvent): void {
    if (this.subscribed) {
      this.deliver(event);
      return;
    }
    this.queue.push({ at: this.now(), event });
    this.prune();
  }

  /** Status is state, not a log: only the latest is kept and replayed. */
  status(status: MeetCaptionStatus): void {
    this.lastStatus = status;
    if (this.subscribed) this.sendStatus(status);
  }

  /**
   * A renderer asked for `meetCode`'s stream. Replays the last status, then every buffered event of
   * that meeting younger than `maxAgeMs`, oldest first. Events of another meeting are dropped.
   */
  subscribe(meetCode: string): void {
    this.subscribed = true;
    this.prune();
    const queued = this.queue;
    this.queue = [];
    if (this.lastStatus && this.lastStatus.meetCode === meetCode) this.sendStatus(this.lastStatus);
    for (const entry of queued) {
      if (entry.event.meetCode === meetCode) this.deliver(entry.event);
    }
  }

  /** The renderer is gone, reloading, or turned the stream off: buffer from now on. */
  unsubscribe(): void {
    this.subscribed = false;
  }

  /** The stream for the meeting ended for good; nothing left is worth replaying. */
  clear(): void {
    this.queue = [];
    this.lastStatus = null;
  }

  /**
   * Stamps `sentAtMs` with `now()` (alignedNow in main) at send time, live or replayed, so the
   * renderer can move the event's times onto its own Date.now() axis. A copy: the buffered entry
   * is never mutated.
   */
  private deliver(event: MeetCaptionEvent): void {
    this.send({ ...event, sentAtMs: this.now() });
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    let drop = 0;
    while (drop < this.queue.length && this.queue[drop].at < cutoff) drop++;
    if (drop > 0) this.queue = this.queue.slice(drop);
  }
}

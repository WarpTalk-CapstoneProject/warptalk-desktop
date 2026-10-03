/**
 * Who the bridge popup belongs to, and what the web app has to be told when it goes.
 *
 * WHY THIS EXISTS
 *   The popup's `closed` handler used to drop its reference and tell nobody. The web app's
 *   trigger (warptalk-web use-bridge-trigger.ts) kept a record of the target it had opened, went
 *   on believing the popup was up, and skipped every later open for that same target as a no-op -
 *   so a user who closed the popup mid-meeting could not get it back until the meeting changed.
 *   Clicking the notification that had announced it did nothing either: it only ever focused a
 *   window that still existed.
 *
 * TWO KINDS OF CLOSE
 *   The web app closing the popup (`withdraw`) and the user closing it are different events, and
 *   only the second is news. The first is known to the caller already, and echoing it back would
 *   race with an open that follows straight after it - the trigger moving from one room to the
 *   next closes and reopens in the same breath. So `withdraw` forgets the window BEFORE it is
 *   closed, and `closed` reports only a window this ledger still held.
 *
 * WHAT IT REMEMBERS AFTER A CLOSE
 *   What the web app last asked to show, until the web app withdraws it. That is what the tray's
 *   "Show meeting panel" and a late notification click bring back: the popup the app still wants,
 *   rather than whatever a notification from twenty minutes ago happened to announce.
 *
 * Generic over the window type so the tests need no Electron.
 */

export interface TranscriptPanelTarget {
  roomId: string;
}

export class TranscriptPanelLedger<W> {
  private requestedTarget: TranscriptPanelTarget | null = null;
  private current: { window: W; roomId: string } | null = null;

  /** The popup on screen, or null. May be destroyed; callers check, as they always have. */
  get window(): W | null {
    return this.current?.window ?? null;
  }

  /** What the web app still wants shown, whether or not the popup is open right now. */
  get reopenTarget(): TranscriptPanelTarget | null {
    return this.requestedTarget;
  }

  /** The web app asked for the popup to show `roomId`. */
  request(roomId: string): void {
    this.requestedTarget = { roomId };
  }

  /** `window` is now showing `roomId` - a new popup, or an existing one navigated to it. */
  shown(window: W, roomId: string): void {
    this.current = { window, roomId };
  }

  /**
   * The web app is done with the popup. Returns the window for the caller to close.
   *
   * Forgotten first, so its `closed` event finds nothing and reports nothing.
   */
  withdraw(): W | null {
    this.requestedTarget = null;
    const window = this.current?.window ?? null;
    this.current = null;
    return window;
  }

  /**
   * A popup window closed. Returns what it was showing when that close is news - the user's, not
   * one the web app asked for - and null otherwise.
   */
  closed(window: W): TranscriptPanelTarget | null {
    if (this.current?.window !== window) return null;
    const { roomId } = this.current;
    this.current = null;
    return { roomId };
  }
}

/** What `PanelNavigator` needs from a window. Electron's `loadURL` semantics: `load` rejects. */
export interface PanelLoader<W> {
  currentUrl(window: W): string;
  load(window: W, target: string): Promise<void>;
  /** The "cannot reach WarpTalk Web" page shipped with the app. */
  loadFallback(window: W): Promise<void>;
  isDestroyed(window: W): boolean;
  report(message: string, error: unknown): void;
}

/** Electron rejects a navigation that another navigation replaced with ERR_ABORTED (-3). */
export function isAbortedLoad(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown } | null;
  return e?.code === "ERR_ABORTED" || e?.errno === -3;
}

/**
 * Sends the popup to a URL, once.
 *
 * WHY THIS EXISTS
 *   The web app can ask for the same popup twice in the same breath. The first open created the
 *   window and started loading; the second found a window whose URL was still empty, so it loaded
 *   the same target again. That aborted the first load, whose catch took ERR_ABORTED for "the web
 *   UI is unreachable" and loaded the offline page - aborting the second load in turn. The popup
 *   was left on "Cannot connect to WarpTalk Web" with the network fine (field log 2026-10-03,
 *   23:00:06Z), until something happened to open it again.
 *
 * TWO RULES
 *   A second request for where the window is already going joins the load in flight.
 *   A load that was replaced by another navigation has not failed: the offline page is for a load
 *   that failed on its own, and only while it is still the latest one asked for.
 */
export class PanelNavigator<W> {
  private readonly loader: PanelLoader<W>;
  private inflight: { window: W; target: string; done: Promise<void> } | null = null;

  constructor(loader: PanelLoader<W>) {
    this.loader = loader;
  }

  /**
   * Whether `window` is on its way to `target` right now.
   *
   * One popup per meeting: while it is being created, another open for the same meeting - the
   * user switched tab or window and the web app's trigger ran again - has nothing to add, and
   * must not show or focus a window that has not painted yet.
   */
  isLoading(window: W, target: string): boolean {
    return this.inflight?.window === window && this.inflight.target === target;
  }

  go(window: W, target: string): Promise<void> {
    const inflight = this.inflight;
    if (inflight && inflight.window === window) {
      if (inflight.target === target) return inflight.done;
    } else if (this.loader.currentUrl(window) === target) {
      return Promise.resolve();
    }
    const mine = { window, target, done: Promise.resolve() };
    this.inflight = mine;
    mine.done = this.run(mine);
    return mine.done;
  }

  private async run(mine: { window: W; target: string }): Promise<void> {
    try {
      await this.loader.load(mine.window, mine.target);
    } catch (error) {
      if (this.inflight !== mine || isAbortedLoad(error)) return;
      this.loader.report("Failed to load the transcript view:", error);
      if (this.loader.isDestroyed(mine.window)) return;
      try {
        await this.loader.loadFallback(mine.window);
      } catch (fallbackError) {
        this.loader.report("Failed to load the fallback renderer:", fallbackError);
      }
    } finally {
      if (this.inflight === mine) this.inflight = null;
    }
  }
}

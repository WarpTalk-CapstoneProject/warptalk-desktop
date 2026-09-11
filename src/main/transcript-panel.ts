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
  /** Null for the offer, which has no room yet. */
  roomId: string | null;
}

export class TranscriptPanelLedger<W> {
  private requestedTarget: TranscriptPanelTarget | null = null;
  private current: { window: W; roomId: string | null } | null = null;

  /** The popup on screen, or null. May be destroyed; callers check, as they always have. */
  get window(): W | null {
    return this.current?.window ?? null;
  }

  /** What the web app still wants shown, whether or not the popup is open right now. */
  get reopenTarget(): TranscriptPanelTarget | null {
    return this.requestedTarget;
  }

  /** The web app asked for the popup to show `roomId`. */
  request(roomId: string | null): void {
    this.requestedTarget = { roomId };
  }

  /** `window` is now showing `roomId` - a new popup, or an existing one navigated to it. */
  shown(window: W, roomId: string | null): void {
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

/**
 * What a window does when its page process dies (WT-930).
 *
 * WHY
 *   A desktop user pressed End and the main window went white and stayed white. When the renderer
 *   behind a BrowserWindow dies (a crash, an out-of-memory kill, the GPU process taking it down),
 *   Electron leaves the window up with nothing in it, painted in the window's background colour.
 *   That was white, and nothing reacted: `render-process-gone` only stopped the caption feed. The
 *   window stayed blank until the user found the tray and quit.
 *
 *   A browser shows "Aw, Snap!" and a Reload button. This app showed nothing.
 *
 * WHAT HAPPENS NOW
 *   The page is reloaded once, automatically. That is what the user would have done if they had
 *   known to, and it brings back the same route (the room page after End, which loads the record).
 *   If the page keeps dying, reloading it in a loop would only burn CPU and hide the problem. So
 *   after `maxReloads` within `windowMs`, the guard gives up and the caller asks the user instead.
 *
 *   A page that exits cleanly, or one that goes away because the app is quitting, is not a crash
 *   and is left alone.
 *
 * Kept out of index.ts so the policy can be tested without Electron.
 */

/** Electron's `RenderProcessGoneDetails.reason`, as a plain string so tests need no Electron. */
export type RendererGoneReason = string;

export type RendererGoneAction = "reload" | "give-up" | "ignore";

export interface RendererCrashGuardOptions {
  /** Automatic reloads allowed inside `windowMs`. The next crash in the window gives up. */
  maxReloads: number;
  windowMs: number;
}

export const DEFAULT_CRASH_GUARD: RendererCrashGuardOptions = { maxReloads: 2, windowMs: 60_000 };

export class RendererCrashGuard {
  private reloadsAt: number[] = [];
  private readonly options: RendererCrashGuardOptions;
  private readonly clock: () => number;

  constructor(options: RendererCrashGuardOptions = DEFAULT_CRASH_GUARD, clock: () => number = Date.now) {
    this.options = options;
    this.clock = clock;
  }

  /** What to do about a page process that just went away. Records the reload it allows. */
  decide(reason: RendererGoneReason, { isQuitting }: { isQuitting: boolean }): RendererGoneAction {
    // Quitting kills every renderer on purpose; a clean exit is a page that finished, not a crash.
    if (isQuitting || reason === "clean-exit") return "ignore";

    const now = this.clock();
    this.reloadsAt = this.reloadsAt.filter((at) => now - at < this.options.windowMs);
    if (this.reloadsAt.length >= this.options.maxReloads) return "give-up";

    this.reloadsAt.push(now);
    return "reload";
  }

  /** The user chose to reload after a give-up: start counting again. */
  reset(): void {
    this.reloadsAt = [];
  }
}

/**
 * The colour a window shows before its page paints, and after the page process is gone.
 *
 * It matches the web app's own ground (`--canvas` in warptalk-web's globals.css), so a slow first
 * paint does not flash a different colour. The theme is the OS's, the best guess main has: the web
 * app's own choice is only known to the page.
 */
export function windowBackgroundColor(prefersDark: boolean): string {
  return prefersDark ? "#050506" : "#f1f2f4";
}

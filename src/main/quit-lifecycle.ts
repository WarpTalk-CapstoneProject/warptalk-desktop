/**
 * Whether closing the main window hides it to the tray or actually closes it.
 *
 * WHY THIS EXISTS
 *   The main window's `close` handler used to hide to the tray whenever a tray existed. But
 *   `app.quit()` works by closing every window, so the handler cancelled the very close the quit
 *   was waiting on and the app never exited. The tray's own Quit item hid the problem by destroying
 *   the tray first; nothing else could. The macOS Cmd+Q hid the window instead of quitting, and an
 *   updater's `quitAndInstall()` (installer spawned, then `app.quit()`) would have hung for good.
 *
 * THE RULE
 *   Hide only in normal use. Once the app has decided to quit, a close is a close. index.ts sets
 *   `isQuitting` from `before-quit`, which Electron emits before it closes any window, and from
 *   `before-quit-for-update`, because Squirrel.Mac's `quitAndInstall` closes the windows first and
 *   emits `before-quit` only afterwards.
 *
 *   The flag is never cleared. If a quit is cancelled after all (a page refusing to unload), the
 *   next close really closes; the user had asked to quit, so that is the lesser surprise.
 *
 * Pure, so the tests need no Electron.
 */

export interface CloseContext {
  /** No tray means nowhere to bring the window back from, so hiding would strand it. */
  hasTray: boolean;
  isQuitting: boolean;
}

export function shouldHideOnClose({ hasTray, isQuitting }: CloseContext): boolean {
  return hasTray && !isQuitting;
}

/**
 * Whether a page's `beforeunload` may stop the app from quitting.
 *
 * The web app's settings pages register `beforeunload` while an auto-save is pending or has failed
 * (warptalk-web src/hooks/use-auto-save.ts). A browser turns that into a "Leave site?" prompt;
 * Electron shows nothing and silently cancels the close - and with it the quit. So Quit did
 * nothing, and the updater's "Restart now" would do nothing either, with the installer already
 * spawned and about to kill the app from outside anyway.
 *
 * Once the app is quitting the page is overruled: an unsaved settings change is lost, which is the
 * lesser harm next to a Quit that does not quit. Outside a quit the page keeps its veto, so a
 * navigation inside the app still cannot discard the change.
 */
export function shouldIgnoreBeforeUnload({ isQuitting }: { isQuitting: boolean }): boolean {
  return isQuitting;
}

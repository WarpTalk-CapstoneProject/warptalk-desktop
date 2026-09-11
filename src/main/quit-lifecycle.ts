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

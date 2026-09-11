import test from "node:test";
import assert from "node:assert/strict";

import { shouldHideOnClose, shouldIgnoreBeforeUnload } from "../quit-lifecycle.ts";
import { trayMenuTemplate } from "../tray-menu.ts";

test("closing the window in normal use hides it to the tray", () => {
  assert.equal(shouldHideOnClose({ hasTray: true, isQuitting: false }), true);
});

test("a close that is part of quitting goes through", () => {
  // `app.quit()` closes every window and waits for them. Hiding here cancelled the close, and with
  // it the quit: Cmd+Q hid the window, and quitAndInstall would have hung with the installer
  // already spawned.
  assert.equal(shouldHideOnClose({ hasTray: true, isQuitting: true }), false);
});

test("without a tray a close is a close, quitting or not", () => {
  // The tray icon failed to load: a hidden window would have no way back.
  assert.equal(shouldHideOnClose({ hasTray: false, isQuitting: false }), false);
  assert.equal(shouldHideOnClose({ hasTray: false, isQuitting: true }), false);
});

test("the tray's Quit item asks the app to quit and does nothing else", () => {
  const calls = [];
  const template = trayMenuTemplate("WarpTalk", { meetingPanelAvailable: false }, {
    showApp: () => calls.push("showApp"),
    showMeetingPanel: () => calls.push("showMeetingPanel"),
    quit: () => calls.push("quit"),
  });

  template.find((item) => item.label === "Quit").click();
  assert.deepEqual(calls, ["quit"]);
});

test("a page's beforeunload cannot cancel a quit", () => {
  // The web app's settings pages hold `beforeunload` while an auto-save is pending. Electron shows
  // no prompt for it and simply cancels the close, so Quit - and the updater's Restart now - did
  // nothing at all.
  assert.equal(shouldIgnoreBeforeUnload({ isQuitting: true }), true);
});

test("outside a quit the page keeps its veto", () => {
  assert.equal(shouldIgnoreBeforeUnload({ isQuitting: false }), false);
});

import test from "node:test";
import assert from "node:assert/strict";

import { TranscriptPanelLedger } from "../transcript-panel.ts";
import { trayMenuTemplate } from "../tray-menu.ts";

/** Stands in for a BrowserWindow: the ledger only ever compares identities. */
const popup = (name) => ({ name });

test("a popup the user closes is reported, with what it was showing", () => {
  const ledger = new TranscriptPanelLedger();
  const win = popup("a");
  ledger.request("room-1");
  ledger.shown(win, "room-1");

  // The web app's trigger keeps a record of what it opened. Silence here is what lost the popup:
  // the record said "open" and every later open for the same room was skipped as a no-op.
  assert.deepEqual(ledger.closed(win), { roomId: "room-1" });
  assert.equal(ledger.window, null);
});

test("the offer is reported as a null room, not as nothing", () => {
  const ledger = new TranscriptPanelLedger();
  const win = popup("offer");
  ledger.request(null);
  ledger.shown(win, null);
  assert.deepEqual(ledger.closed(win), { roomId: null });
});

test("a close the web app asked for is not echoed back as the user's", () => {
  const ledger = new TranscriptPanelLedger();
  const win = popup("a");
  ledger.request("room-1");
  ledger.shown(win, "room-1");

  assert.equal(ledger.withdraw(), win, "the caller is handed the window to close");
  // Electron fires `closed` afterwards. Reporting it would race an open that follows in the same
  // breath - the trigger moving from one meeting to the next closes and reopens back to back.
  assert.equal(ledger.closed(win), null);
});

test("an old window's close cannot clear the popup that replaced it", () => {
  const ledger = new TranscriptPanelLedger();
  const first = popup("first");
  const second = popup("second");
  ledger.request("room-1");
  ledger.shown(first, "room-1");
  ledger.withdraw();
  ledger.request("room-2");
  ledger.shown(second, "room-2");

  assert.equal(ledger.closed(first), null);
  assert.equal(ledger.window, second);
});

test("a navigated popup reports where it ended up", () => {
  const ledger = new TranscriptPanelLedger();
  const win = popup("a");
  ledger.request(null);
  ledger.shown(win, null);
  // The offer was accepted: the same window now shows the room.
  ledger.request("room-7");
  ledger.shown(win, "room-7");
  assert.deepEqual(ledger.closed(win), { roomId: "room-7" });
});

test("after the user closes it, the popup the app still wants can be brought back", () => {
  const ledger = new TranscriptPanelLedger();
  const win = popup("a");
  ledger.request("room-1");
  ledger.shown(win, "room-1");
  ledger.closed(win);

  // What the tray item and a late notification click reopen.
  assert.deepEqual(ledger.reopenTarget, { roomId: "room-1" });
});

test("once the web app withdraws it, there is nothing to bring back", () => {
  const ledger = new TranscriptPanelLedger();
  ledger.request("room-1");
  ledger.shown(popup("a"), "room-1");
  ledger.withdraw();
  assert.equal(ledger.reopenTarget, null);
});

test("the tray offers the meeting panel, and only when there is one to show", () => {
  const calls = [];
  const actions = {
    showApp: () => calls.push("app"),
    showMeetingPanel: () => calls.push("panel"),
    checkForUpdates: () => calls.push("updates"),
    quit: () => calls.push("quit"),
  };

  const find = (template) => template.find((item) => item.label === "Show meeting panel");

  const available = find(trayMenuTemplate("WarpTalk", { meetingPanelAvailable: true }, actions));
  assert.ok(available, "the tray had no way back to the popup at all");
  assert.equal(available.enabled, true);
  available.click();
  assert.deepEqual(calls, ["panel"]);

  const none = find(trayMenuTemplate("WarpTalk", { meetingPanelAvailable: false }, actions));
  assert.equal(none.enabled, false, "disabled, not hidden, so it stays where the user learned it");
});

test("the tray offers only entries that do something", () => {
  const template = trayMenuTemplate("WarpTalk", { meetingPanelAvailable: true }, {
    showApp: () => {},
    showMeetingPanel: () => {},
    checkForUpdates: () => {},
    quit: () => {},
  });
  const labels = template.filter((item) => item.label).map((item) => item.label);
  // Start/Stop Translation used to sit between these, with TODO handlers: a click did nothing.
  assert.deepEqual(labels, ["Show WarpTalk", "Show meeting panel", "Check for Updates…", "Quit"]);
  // And no separator is left doubled up where they were.
  const kinds = template.map((item) => (item.type === "separator" ? "-" : "item"));
  assert.ok(!kinds.join(",").includes("-,-"), `adjacent separators: ${kinds.join(",")}`);
});

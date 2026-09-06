import test from "node:test";
import assert from "node:assert/strict";

import { MeetPresenceWatcher } from "../meet-presence.ts";
import { isMeetWindowTitle, extractMeetCode, isLikelyMeetingWindow } from "../windows-loopback-sources.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Titles the sensor is given, swappable between polls. */
function fakeWindows(initial = []) {
  const state = { titles: initial, calls: 0, fail: false };
  const list = async () => {
    state.calls += 1;
    if (state.fail) throw new Error("enumeration failed");
    return state.titles;
  };
  return { state, list };
}

test("presence detection is narrower than the loopback picker's predicate", () => {
  // The picker is allowed to offer any browser window; presence is not. If these ever share a
  // predicate, the widget appears whenever a browser is open, which is always.
  assert.equal(isLikelyMeetingWindow("Inbox (12) - Google Chrome"), true);
  assert.equal(isMeetWindowTitle("Inbox (12) - Google Chrome"), false);
  assert.equal(isMeetWindowTitle("YouTube - Mozilla Firefox"), false);
  assert.equal(isMeetWindowTitle("WarpTalk"), false);
});

test("both title shapes Meet produces are recognised", () => {
  assert.equal(isMeetWindowTitle("Daily standup - Google Meet - Google Chrome"), true);
  assert.equal(isMeetWindowTitle("meet.google.com is sharing your screen"), true);
  // Unnamed call: no words, just the code, and Meet writes the separator as an en dash.
  assert.equal(isMeetWindowTitle("Meet – abc-defg-hij"), true);
  assert.equal(isMeetWindowTitle("Meet - abc-defg-hij"), true);
});

test("the room code is read when the title carries one, and never invented", () => {
  assert.equal(extractMeetCode("Meet – abc-defg-hij"), "abc-defg-hij");
  // A named meeting is the common case and it has no code. Callers must survive this.
  assert.equal(extractMeetCode("Daily standup - Google Meet - Google Chrome"), null);
  assert.equal(extractMeetCode("Inbox (12) - Google Chrome"), null);
});

test("arming answers immediately instead of waiting out the first interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({
    listWindowTitles: windows.list,
    onChange: (presence) => seen.push(presence),
    now: () => 1000,
  });

  watcher.arm();
  await flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].meetWindowVisible, true);
  assert.equal(seen[0].meetCode, "abc-defg-hij");
  watcher.disarm();
});

test("a disarmed watcher never enumerates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({ listWindowTitles: windows.list, onChange: () => {} });

  t.mock.timers.tick(30000);
  await flush();

  assert.equal(windows.state.calls, 0);
});

test("only changes are reported, not every tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({
    listWindowTitles: windows.list,
    onChange: (presence) => seen.push(presence),
    intervalMs: 1000,
  });

  watcher.arm();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();

  assert.ok(windows.state.calls >= 3, "should keep polling");
  assert.equal(seen.length, 1, "unchanged observations must stay quiet");

  windows.state.titles = ["Inbox (12) - Google Chrome"];
  t.mock.timers.tick(1000);
  await flush();

  assert.equal(seen.length, 2);
  assert.equal(seen[1].meetWindowVisible, false);
  watcher.disarm();
});

test("a failed enumeration keeps the last answer instead of reporting the meeting gone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({
    listWindowTitles: windows.list,
    onChange: (presence) => seen.push(presence),
    intervalMs: 1000,
  });

  watcher.arm();
  await flush();
  assert.equal(seen.length, 1);

  // A shell that failed says nothing about whether the user is still in the call. Reporting false
  // here would close the widget over a transient error.
  windows.state.fail = true;
  t.mock.timers.tick(1000);
  await flush();

  assert.equal(seen.length, 1);
  watcher.disarm();
});

test("re-arming reports what is on screen rather than comparing against the last meeting", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({
    listWindowTitles: windows.list,
    onChange: (presence) => seen.push(presence),
  });

  watcher.arm();
  await flush();
  watcher.disarm();
  watcher.arm();
  await flush();

  assert.equal(seen.length, 2, "the second session must get its own first answer");
  watcher.disarm();
});

test("arming twice does not start a second interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const windows = fakeWindows([]);
  const watcher = new MeetPresenceWatcher({
    listWindowTitles: windows.list,
    onChange: () => {},
    intervalMs: 1000,
  });

  watcher.arm();
  watcher.arm();
  await flush();
  const afterArm = windows.state.calls;

  t.mock.timers.tick(1000);
  await flush();

  assert.equal(windows.state.calls, afterArm + 1, "one tick must mean one enumeration");
  watcher.disarm();
});

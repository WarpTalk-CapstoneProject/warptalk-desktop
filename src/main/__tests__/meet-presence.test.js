import test from "node:test";
import assert from "node:assert/strict";

import { MeetPresenceWatcher } from "../meet-presence.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * What the sensor sees, swappable between polls.
 *
 * `sighting: null` is a real answer - no Meet window. `fail` REJECTS, which is the other thing
 * entirely: the read did not happen. The watcher must never turn the second into the first.
 */
function fakeWindows(initial = null) {
  const state = { sighting: initial, calls: 0, fail: false };
  const read = async () => {
    state.calls += 1;
    if (state.fail) throw new Error("sensor read failed");
    return state.sighting;
  };
  return { state, read };
}

/** A normal-window sighting, which is the shape that carries a room code. */
function seen(meetCode = "abc-defg-hij") {
  return { meetCode, processId: 4242, via: "document" };
}

/*
 * The title-matching tests that used to sit here are gone with the predicate they covered.
 * Presence no longer reads window titles at all - it reads the browser's URL, because a title is
 * written by the page and an address is not. What remains below is the policy, which did not
 * change: when to look, what to do when a look fails, and when an observation is worth reporting.
 */

test("arming answers immediately instead of waiting out the first interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const observed = [];
  const windows = fakeWindows(seen());
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: windows.read,
    onChange: (presence) => observed.push(presence),
    now: () => 1000,
  });

  watcher.arm();
  await flush();

  assert.equal(observed.length, 1);
  assert.equal(observed[0].meetWindowVisible, true);
  assert.equal(observed[0].meetCode, "abc-defg-hij");
  watcher.disarm();
});

test("the offer reads the code of the call on screen, and nothing once it is gone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const windows = fakeWindows(seen("jkq-yaax-phw"));
  const watcher = new MeetPresenceWatcher({ readMeetSighting: windows.read, onChange: () => {} });

  assert.equal(watcher.meetCode, null, "nothing has been seen before the first look");
  watcher.arm();
  await flush();
  assert.equal(watcher.meetCode, "jkq-yaax-phw");

  windows.state.sighting = null;
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(watcher.meetCode, null, "a call that left the screen must not name the next offer's room");

  watcher.disarm();
  assert.equal(watcher.meetCode, null);
});

test("a disarmed watcher never enumerates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({ readMeetSighting: windows.read, onChange: () => {} });

  t.mock.timers.tick(30000);
  await flush();

  assert.equal(windows.state.calls, 0);
});

test("only changes are reported, not every tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const observed = [];
  const windows = fakeWindows(seen());
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: windows.read,
    onChange: (presence) => observed.push(presence),
    intervalMs: 1000,
  });

  watcher.arm();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();

  assert.ok(windows.state.calls >= 3, "should keep polling");
  assert.equal(observed.length, 1, "unchanged observations must stay quiet");

  // The call ended: a real answer of "no Meet window", not a failed read.
  windows.state.sighting = null;
  t.mock.timers.tick(1000);
  await flush();

  assert.equal(observed.length, 2);
  assert.equal(observed[1].meetWindowVisible, false);
  watcher.disarm();
});

test("a failed enumeration keeps the last answer instead of reporting the meeting gone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seen = [];
  const windows = fakeWindows(["Meet – abc-defg-hij"]);
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: windows.read,
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
    readMeetSighting: windows.read,
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
    readMeetSighting: windows.read,
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

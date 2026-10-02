import test from "node:test";
import assert from "node:assert/strict";

import {
  captureStateOf,
  MEET_GONE_GRACE_MS,
  MeetGoneCaptureGuard,
  prepareCaptureRequest,
  resolveMeetSightingTarget,
  sendToWindows,
} from "../capture-target.ts";
import { MeetPresenceWatcher } from "../meet-presence.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock the test drives by hand, so a 60 s grace runs in no time at all. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

function guardWith(clock, overrides = {}) {
  const stops = [];
  const guard = new MeetGoneCaptureGuard({
    onGone: () => stops.push("gone"),
    isWatching: () => true,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { guard, stops };
}

const visible = { meetWindowVisible: true };
const gone = { meetWindowVisible: false };

// --- target resolution -------------------------------------------------------------------------

test("a live sighting with a process resolves to that process", () => {
  assert.deepEqual(resolveMeetSightingTarget({ armed: true, visible: true, processId: 4242 }), {
    ok: true,
    processId: 4242,
  });
});

test("no sighting, or a watcher that is not looking, is meet-sighting-missing", () => {
  assert.deepEqual(resolveMeetSightingTarget({ armed: true, visible: false, processId: null }), {
    ok: false,
    reason: "meet-sighting-missing",
  });
  // A disarmed watcher's stale PID must not be trusted.
  assert.deepEqual(resolveMeetSightingTarget({ armed: false, visible: true, processId: 4242 }), {
    ok: false,
    reason: "meet-sighting-missing",
  });
});

test("a sighting the platform cannot attribute (macOS) is meet-sighting-no-process", () => {
  for (const processId of [null, 0, -1, 1.5]) {
    assert.deepEqual(resolveMeetSightingTarget({ armed: true, visible: true, processId }), {
      ok: false,
      reason: "meet-sighting-no-process",
    });
  }
});

test("meet-sighting replaces the renderer's window and PID with the sighting's", () => {
  const prepared = prepareCaptureRequest(
    {
      target: "meet-sighting",
      stopWhenMeetGone: true,
      sourceId: "window:1:0",
      targetProcessId: 999,
      consentGranted: true,
      includeTargetProcessTree: true,
      mode: "text-only",
    },
    { armed: true, visible: true, processId: 4242 },
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.startedVia, "meet-sighting");
  assert.equal(prepared.stopWhenMeetGone, true);
  assert.deepEqual(prepared.request, {
    targetProcessId: 4242,
    consentGranted: true,
    includeTargetProcessTree: true,
    mode: "text-only",
  });
});

test("meet-sighting with no sighting is refused as R8 before any capture gate", () => {
  const refused = prepareCaptureRequest(
    { target: "meet-sighting", consentGranted: true, includeTargetProcessTree: true },
    { armed: true, visible: false, processId: null },
  );
  assert.deepEqual(refused, { started: false, riskId: "R8", reason: "meet-sighting-missing" });
});

test("a request without a target passes through untouched and never opts into the stop", () => {
  const prepared = prepareCaptureRequest(
    { sourceId: "window:1:0", consentGranted: true, stopWhenMeetGone: true },
    { armed: true, visible: true, processId: 4242 },
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.startedVia, "source");
  assert.equal(prepared.stopWhenMeetGone, false);
  assert.deepEqual(prepared.request, { sourceId: "window:1:0", consentGranted: true });

  const byPid = prepareCaptureRequest({ targetProcessId: 7 }, { armed: false, visible: false, processId: null });
  assert.equal(byPid.startedVia, "process-id");
  assert.deepEqual(prepareCaptureRequest(undefined, { armed: false, visible: false, processId: null }).request, {});
});

// --- stop when Meet is gone ----------------------------------------------------------------------

test("the grace is far longer than the web trigger's 8 s offer grace", () => {
  assert.ok(MEET_GONE_GRACE_MS >= 60_000);
});

test("a PiP hand-off (gone, then seen again inside the grace) never stops the capture", () => {
  const clock = fakeClock();
  const { guard, stops } = guardWith(clock);
  guard.begin();
  guard.observe(gone); // tab switched away
  clock.advance(9_000); // longer than the web trigger's whole grace
  guard.observe(visible); // the PiP window is seen
  clock.advance(MEET_GONE_GRACE_MS * 2);
  assert.deepEqual(stops, []);
  assert.equal(guard.watching, true);
  assert.equal(clock.pending, 0);
});

test("Meet gone for the whole grace stops the capture once", () => {
  const clock = fakeClock();
  const { guard, stops } = guardWith(clock);
  guard.begin();
  guard.observe(gone);
  clock.advance(MEET_GONE_GRACE_MS - 1);
  assert.deepEqual(stops, []);
  // Repeated absence does not restart the countdown.
  guard.observe(gone);
  clock.advance(1);
  assert.deepEqual(stops, ["gone"]);
  guard.observe(gone);
  clock.advance(MEET_GONE_GRACE_MS * 2);
  assert.deepEqual(stops, ["gone"]);
});

test("a watcher disarmed during the grace never stops the capture", () => {
  const clock = fakeClock();
  let armed = true;
  const { guard, stops } = guardWith(clock, { isWatching: () => armed });
  guard.begin();
  guard.observe(gone);
  armed = false;
  clock.advance(MEET_GONE_GRACE_MS);
  assert.deepEqual(stops, []);
});

test("without begin (an older renderer, or a picked window) presence changes do nothing", () => {
  const clock = fakeClock();
  const { guard, stops } = guardWith(clock);
  guard.observe(gone);
  clock.advance(MEET_GONE_GRACE_MS * 2);
  assert.deepEqual(stops, []);
});

test("a renderer stop during the grace cancels it", () => {
  const clock = fakeClock();
  const { guard, stops } = guardWith(clock);
  guard.begin();
  guard.observe(gone);
  guard.end();
  clock.advance(MEET_GONE_GRACE_MS);
  assert.deepEqual(stops, []);
  assert.equal(guard.pending, false);
});

test("end to end with the real watcher: tab switch then PiP survives, a closed call does not", async () => {
  const clock = fakeClock();
  const state = { sighting: { meetCode: "abc-defg-hij", processId: 4242, via: "document" } };
  let guard;
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: async () => state.sighting,
    onChange: (presence) => guard.observe(presence),
    intervalMs: 60_000_000,
  });
  const stops = [];
  guard = new MeetGoneCaptureGuard({
    onGone: () => stops.push("gone"),
    isWatching: () => watcher.armed,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  watcher.arm();
  await flush();
  assert.equal(watcher.meetWindowVisible, true);
  assert.equal(watcher.meetProcessId, 4242);
  guard.begin();

  const poll = async () => {
    await watcher["poll"]();
    await flush();
  };
  state.sighting = null; // tab switch
  await poll();
  clock.advance(3_000);
  state.sighting = { meetCode: null, processId: 4242, via: "pip" };
  await poll();
  clock.advance(MEET_GONE_GRACE_MS);
  assert.deepEqual(stops, []);

  state.sighting = null; // the call ended
  await poll();
  clock.advance(MEET_GONE_GRACE_MS);
  assert.deepEqual(stops, ["gone"]);
  watcher.disarm();
  assert.equal(watcher.meetWindowVisible, false);
});

// --- capture state --------------------------------------------------------------------------------

test("capture state reports the running capture, and nothing while none runs", () => {
  assert.deepEqual(
    captureStateOf({ capturing: true, mode: "text-only", targetProcessId: 4242, startedVia: "meet-sighting" }),
    { capturing: true, mode: "text-only", targetProcessId: 4242, startedVia: "meet-sighting" },
  );
  assert.deepEqual(
    captureStateOf({ capturing: false, mode: "voice", targetProcessId: 4242, startedVia: "source" }),
    { capturing: false, mode: null, targetProcessId: null, startedVia: null },
  );
});

// --- broadcast ------------------------------------------------------------------------------------

function fakeWindow(destroyed = false) {
  const sent = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel, ...args) => sent.push([channel, ...args]) },
  };
}

test("room activation reaches the main window and the popup, skipping dead or missing ones", () => {
  const main = fakeWindow();
  const popup = fakeWindow();
  const dead = fakeWindow(true);
  const count = sendToWindows([main, popup, dead, null, main], "bridge:room-activated", "room-1");
  assert.equal(count, 2);
  assert.deepEqual(main.sent, [["bridge:room-activated", "room-1"]]);
  assert.deepEqual(popup.sent, [["bridge:room-activated", "room-1"]]);
  assert.deepEqual(dead.sent, []);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  MEET_WINDOW_CAPTURE_ARM_TTL_MS,
  MeetWindowCaptureArm,
  armPreconditionRefusal,
  resolveMeetWindowSource,
} from "../meet-window-capture.ts";
import { MeetPresenceWatcher } from "../meet-presence.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const okInput = {
  platform: "win32",
  fromMainWindow: true,
  roomId: "room-1",
  consentedCaptureRunning: true,
};

test("arm preconditions: passes on Windows, from the main window, with a room and a consented capture", () => {
  assert.equal(armPreconditionRefusal(okInput), null);
});

test("arm preconditions: every other platform is unsupported, before anything else is asked", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(
      armPreconditionRefusal({ ...okInput, platform, fromMainWindow: false, consentedCaptureRunning: false }),
      "unsupported-platform",
    );
  }
});

test("arm preconditions: a sender that is not the main window is refused", () => {
  assert.equal(armPreconditionRefusal({ ...okInput, fromMainWindow: false }), "not-main-window");
});

test("arm preconditions: no running consented capture, or no room, is consent-required", () => {
  assert.equal(armPreconditionRefusal({ ...okInput, consentedCaptureRunning: false }), "consent-required");
  for (const roomId of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(armPreconditionRefusal({ ...okInput, roomId }), "consent-required");
  }
});

const sources = [
  { id: "window:1111:0", name: "Inbox - Google Chrome" },
  { id: "window:2222:0", name: "Meet - abc-defg-hij - Google Chrome" },
  { id: "screen:0:0", name: "Entire screen" },
];

test("source matching: the source whose HWND is the sighted one", () => {
  const resolved = resolveMeetWindowSource({ armed: true, visible: true, windowHandle: 2222 }, sources);
  assert.deepEqual(resolved, { ok: true, source: sources[1] });
});

test("source matching: no watcher or no Meet on screen is meet-sighting-missing", () => {
  assert.deepEqual(resolveMeetWindowSource({ armed: false, visible: true, windowHandle: 2222 }, sources), {
    ok: false,
    reason: "meet-sighting-missing",
  });
  assert.deepEqual(resolveMeetWindowSource({ armed: true, visible: false, windowHandle: 2222 }, sources), {
    ok: false,
    reason: "meet-sighting-missing",
  });
});

test("source matching: a sighting with no usable HWND, or a window gone from the list, is meet-window-not-found", () => {
  for (const windowHandle of [null, 0, -5, 1.5, Number.NaN, 9999]) {
    assert.deepEqual(resolveMeetWindowSource({ armed: true, visible: true, windowHandle }, sources), {
      ok: false,
      reason: "meet-window-not-found",
    });
  }
});

test("source matching: never by title - a window that only says Meet in its name is not taken", () => {
  const lookalike = [{ id: "window:3333:0", name: "Meet - abc-defg-hij - Google Chrome" }];
  assert.equal(resolveMeetWindowSource({ armed: true, visible: true, windowHandle: 2222 }, lookalike).ok, false);
});

test("one-shot: the arming webContents gets the source once, then the arm is spent", () => {
  const arm = new MeetWindowCaptureArm();
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 1000);
  assert.equal(arm.isArmed(1000), true);
  assert.deepEqual(arm.take(7, 1500), { source: sources[1], roomId: "room-1", firstForRoom: true });
  assert.equal(arm.isArmed(1500), false);
  assert.equal(arm.take(7, 1600), null);
});

test("one-shot: another webContents neither receives the grant nor burns it", () => {
  const arm = new MeetWindowCaptureArm();
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 0);
  assert.equal(arm.take(8, 10), null);
  assert.equal(arm.take(7, 20)?.source, sources[1]);
});

test("one-shot: expires after the TTL and is dropped", () => {
  const arm = new MeetWindowCaptureArm();
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 0);
  assert.equal(arm.take(7, MEET_WINDOW_CAPTURE_ARM_TTL_MS - 1)?.roomId, "room-1");
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 0);
  assert.equal(arm.isArmed(MEET_WINDOW_CAPTURE_ARM_TTL_MS), false);
  assert.equal(arm.take(7, MEET_WINDOW_CAPTURE_ARM_TTL_MS), null);
  // Dropped, not merely hidden: an earlier clock reading cannot bring it back.
  assert.equal(arm.take(7, 1), null);
});

test("one-shot: a second arm replaces the first, and disarm clears it", () => {
  const arm = new MeetWindowCaptureArm();
  arm.arm({ webContentsId: 7, source: sources[0], roomId: "room-1" }, 0);
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-2" }, 100);
  assert.equal(arm.take(7, 200)?.source, sources[1]);
  assert.equal(arm.take(7, 300), null);

  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-2" }, 400);
  arm.disarm();
  assert.equal(arm.take(7, 500), null);
});

test("one-shot: firstForRoom is true once per room", () => {
  const arm = new MeetWindowCaptureArm();
  const grant = (roomId, now) => {
    arm.arm({ webContentsId: 7, source: sources[1], roomId }, now);
    return arm.take(7, now + 1);
  };
  assert.equal(grant("room-1", 0).firstForRoom, true);
  assert.equal(grant("room-1", 10).firstForRoom, false);
  assert.equal(grant("room-2", 20).firstForRoom, true);
});

test("watcher: keeps the sighting's HWND in main, never in the presence it emits, and drops it with the sighting", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sighting = { meetCode: "abc-defg-hij", processId: 4242, windowHandle: 2222, via: "document" };
  const observed = [];
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: async () => sighting,
    onChange: (presence) => observed.push(presence),
    intervalMs: 3000,
    now: () => 1000,
  });
  watcher.arm();
  await flush();
  assert.equal(watcher.meetWindowHandle, 2222);
  assert.equal(observed.length, 1);
  assert.equal("windowHandle" in observed[0], false);

  // An older sensor payload has no windowHandle at all: the sighting stands, the handle does not.
  sighting = { meetCode: "abc-defg-hij", processId: 4242, via: "document" };
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(watcher.meetWindowVisible, true);
  assert.equal(watcher.meetWindowHandle, null);

  sighting = { meetCode: null, processId: 4242, windowHandle: 3333, via: "pip" };
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(watcher.meetWindowHandle, 3333);

  watcher.disarm();
  assert.equal(watcher.meetWindowHandle, null);
});

test("B18: Meet in picture-in-picture is never armed, whatever its handle", () => {
  const pipSources = [...sources, { id: "window:3333:0", name: "Meet - abc-defg-hij" }];
  assert.deepEqual(
    resolveMeetWindowSource({ armed: true, visible: true, windowHandle: 3333, inPictureInPicture: true }, pipSources),
    { ok: false, reason: "meet-not-on-tab" },
  );
  // Even a handle that is the browser window: the tracker says the call is in PiP, so the tab is not Meet.
  assert.deepEqual(
    resolveMeetWindowSource({ armed: true, visible: true, windowHandle: 2222, inPictureInPicture: true }, sources),
    { ok: false, reason: "meet-not-on-tab" },
  );
  // Back on the tab: the same window resolves again (the web app re-arms after a tab return).
  assert.deepEqual(
    resolveMeetWindowSource({ armed: true, visible: true, windowHandle: 2222, inPictureInPicture: false }, sources),
    { ok: true, source: sources[1] },
  );
});

test("B18: a re-arm after the first grant is granted again, and does not announce the recording twice", () => {
  const arm = new MeetWindowCaptureArm();
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 0);
  assert.equal(arm.take(7, 5).firstForRoom, true);
  // Meet went to PiP and came back: the web app arms again for the same room.
  arm.arm({ webContentsId: 7, source: sources[1], roomId: "room-1" }, 60_000);
  assert.deepEqual(arm.take(7, 60_010), { source: sources[1], roomId: "room-1", firstForRoom: false });
});

test("watcher: remembers whether the last sighting was the PiP window, and forgets it on disarm", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sighting = { meetCode: "abc-defg-hij", processId: 4242, windowHandle: 2222, via: "document" };
  const watcher = new MeetPresenceWatcher({
    readMeetSighting: async () => sighting,
    onChange: () => {},
    intervalMs: 3000,
    now: () => 1000,
  });
  watcher.arm();
  await flush();
  assert.equal(watcher.meetWindowVia, "document");

  sighting = { meetCode: "abc-defg-hij", processId: 4242, windowHandle: 3333, via: "pip" };
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(watcher.meetWindowVia, "pip");

  watcher.disarm();
  assert.equal(watcher.meetWindowVia, null);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeWindowsLoopbackSource,
  isLikelyMeetingWindow,
  parseDesktopSourceWindowHandle,
} from "../windows-loopback-sources.ts";

test("parses the window handle from an Electron desktop source id", () => {
  assert.equal(parseDesktopSourceWindowHandle("window:123456:0"), 123456);
  assert.equal(parseDesktopSourceWindowHandle("window:123456:1"), 123456);
});

test("rejects non-window or malformed desktop source ids", () => {
  assert.equal(parseDesktopSourceWindowHandle("screen:1:0"), null);
  assert.equal(parseDesktopSourceWindowHandle("window:0:0"), null);
  assert.equal(parseDesktopSourceWindowHandle("window:not-a-number:0"), null);
});

test("marks browser and Meet windows as likely meeting windows", () => {
  assert.equal(isLikelyMeetingWindow("Daily standup - Google Meet - Google Chrome"), true);
  assert.equal(isLikelyMeetingWindow("meet.google.com is sharing your screen"), true);
  assert.equal(isLikelyMeetingWindow("WarpTalk"), false);
});

test("describes a loopback source without treating the window handle as a pid", () => {
  const source = describeWindowsLoopbackSource(
    { id: "window:123456:0", name: "Daily standup - Google Meet - Google Chrome" },
    4242,
  );

  assert.deepEqual(source, {
    id: "window:123456:0",
    name: "Daily standup - Google Meet - Google Chrome",
    windowHandle: 123456,
    ownerProcessId: 4242,
    likelyMeetingWindow: true,
  });
});

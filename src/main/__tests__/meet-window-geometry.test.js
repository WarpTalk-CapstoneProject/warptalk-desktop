import test from "node:test";
import assert from "node:assert/strict";

import {
  CALL_READ_FRESH_MS,
  meetWindowForArm,
  parseMeetWindowGeometry,
  sameMeetWindowGeometry,
} from "../meet-window-geometry.ts";

/**
 * A normal (restored) Chrome window at (100, 50) on Windows 11, physical pixels: 7 px invisible
 * borders left/right/bottom, none on top; the page starts below a 40 px tab strip, a 46 px toolbar
 * and a 30 px bookmarks bar.
 */
const restored = () => ({
  win: [93, 50, 1393, 857],
  efb: [100, 50, 1386, 850],
  uia: [93, 50, 1393, 857],
  doc: [100, 166, 1386, 850],
});

test("geometry: relative to the visible frame, so moving the window changes nothing", () => {
  const geometry = parseMeetWindowGeometry(restored());
  assert.deepEqual(geometry, {
    frame: { x: 0, y: 0, width: 1286, height: 800 },
    window: { x: -7, y: 0, width: 1300, height: 807 },
    content: { x: 0, y: 116, width: 1286, height: 684 },
  });
  const moved = restored();
  for (const key of ["win", "efb", "uia", "doc"]) moved[key] = moved[key].map((v, i) => v + (i % 2 === 0 ? 500 : 200));
  assert.ok(sameMeetWindowGeometry(parseMeetWindowGeometry(moved), geometry));
});

test("geometry: a maximized window, its borders off-screen, still lines up", () => {
  // 1920x1080 monitor, 48 px taskbar: GetWindowRect hangs 8 px past every edge.
  const geometry = parseMeetWindowGeometry({
    win: [-8, -8, 1928, 1040],
    efb: [0, 0, 1920, 1032],
    uia: [-8, -8, 1928, 1040],
    doc: [0, 109, 1920, 1032],
  });
  assert.deepEqual(geometry.window, { x: -8, y: -8, width: 1936, height: 1048 });
  assert.deepEqual(geometry.content, { x: 0, y: 109, width: 1920, height: 923 });
});

test("geometry: fullscreen (F11 or Meet's own) has no chrome, and the content is the frame", () => {
  const geometry = parseMeetWindowGeometry({
    win: [0, 0, 1920, 1080],
    efb: [0, 0, 1920, 1080],
    uia: [0, 0, 1920, 1080],
    doc: [0, 0, 1920, 1080],
  });
  assert.deepEqual(geometry.content, geometry.frame);
});

test("geometry: without DWM or UI Automation's window rectangle, GetWindowRect stands in", () => {
  const raw = { ...restored(), efb: null, uia: null };
  const geometry = parseMeetWindowGeometry(raw);
  assert.deepEqual(geometry.frame, { x: 0, y: 0, width: 1300, height: 807 });
  assert.deepEqual(geometry.window, geometry.frame);
  assert.deepEqual(geometry.content, { x: 7, y: 116, width: 1286, height: 684 });
});

test("geometry: coordinate spaces that disagree (DPI virtualised) are dropped, not cropped with", () => {
  // At 150% a DPI-unaware GetWindowRect answers in 96-DPI units while DWM answers in pixels.
  assert.equal(
    parseMeetWindowGeometry({ win: [62, 33, 929, 571], efb: [100, 50, 1386, 850], uia: null, doc: [100, 166, 1386, 850] }),
    null,
  );
  // UI Automation's window size far from both window rectangles.
  assert.equal(parseMeetWindowGeometry({ ...restored(), uia: [93, 50, 1043, 655] }), null);
});

test("geometry: a Document outside its window, a minimized window, or a tiny one is dropped", () => {
  assert.equal(parseMeetWindowGeometry({ ...restored(), doc: [100, 166, 1700, 850] }), null);
  assert.equal(
    parseMeetWindowGeometry({ win: [-32000, -32000, -31840, -31972], efb: null, uia: null, doc: [-32000, -32000, -31840, -31972] }),
    null,
  );
  assert.equal(parseMeetWindowGeometry({ win: [0, 0, 150, 100], efb: null, uia: null, doc: [0, 20, 150, 100] }), null);
});

test("geometry: anything malformed is dropped", () => {
  for (const raw of [
    null,
    undefined,
    "geometry",
    {},
    { ...restored(), doc: null },
    { ...restored(), win: [1, 2, 3] },
    { ...restored(), win: [93, 50, "1393", 857] },
    { ...restored(), doc: [100, 166, Number.POSITIVE_INFINITY, 850] },
    { ...restored(), doc: [100, 850, 1386, 166] },
    { ...restored(), win: [93, 50, 1e9, 857] },
  ]) {
    assert.equal(parseMeetWindowGeometry(raw), null, JSON.stringify(raw));
  }
});

test("geometry: equality is by value, and absent equals absent only", () => {
  const a = parseMeetWindowGeometry(restored());
  const b = parseMeetWindowGeometry(restored());
  assert.ok(sameMeetWindowGeometry(a, b));
  assert.ok(sameMeetWindowGeometry(undefined, null));
  assert.equal(sameMeetWindowGeometry(a, undefined), false);
  // The bookmarks bar hidden: the content grows by 30 px.
  const hidden = parseMeetWindowGeometry({ ...restored(), doc: [100, 136, 1386, 850] });
  assert.equal(sameMeetWindowGeometry(a, hidden), false);
});

test("geometry: content is checked against the VISIBLE window and always ends up inside frame", () => {
  // A Document reaching into the invisible left/bottom resize borders (inside GetWindowRect, outside
  // the visible frame) by more than rounding: dropped.
  assert.equal(parseMeetWindowGeometry({ ...restored(), doc: [94, 166, 1386, 856] }), null);
  // A pixel or two past the frame (fractional DPI rounding): clamped back in.
  const rounded = parseMeetWindowGeometry({ ...restored(), doc: [99, 166, 1387, 851] });
  assert.deepEqual(rounded.content, { x: 0, y: 116, width: 1286, height: 684 });
  for (const raw of [restored(), { ...restored(), doc: [99, 166, 1387, 851] }]) {
    const { frame, content } = parseMeetWindowGeometry(raw);
    assert.ok(content.x >= 0 && content.y >= 0);
    assert.ok(content.x + content.width <= frame.width && content.y + content.height <= frame.height);
  }
});

const NOW = 100_000;
const presence = (windowHandle, via = "document") => ({ windowHandle, via });
/** The tracker's latest reading, agreeing with the committed `call`, read at `atMs`. */
const agree = (call, atMs) => ({
  phase: call.phase,
  via: call.via,
  ...(call.windowHandle !== undefined ? { windowHandle: call.windowHandle } : {}),
  atMs,
});

test("arm: a fresh in-call tab reading names the window, and the PiP gate agrees with it", () => {
  // The Meet tab dragged into a new window: the tracker reads 5555, presence still 2222.
  const call = { phase: "in-call", via: "tab", windowHandle: 5555 };
  assert.deepEqual(meetWindowForArm({ sighting: presence(2222), call, latest: agree(call, NOW - 800), nowMs: NOW }), {
    windowHandle: 5555,
    inPictureInPicture: false,
    unsettled: false,
    source: "call-state",
  });
  // Dragged out of PiP back onto a tab: presence still says PiP, the fresh tracker says tab. Not refused.
  assert.equal(
    meetWindowForArm({ sighting: presence(3333, "pip"), call, latest: agree(call, NOW - 800), nowMs: NOW }).inPictureInPicture,
    false,
  );
  // A fresh in-call PiP reading refuses, whatever presence says.
  const inPip = meetWindowForArm({
    sighting: presence(2222),
    call: { phase: "in-call", via: "pip" },
    latest: agree({ phase: "in-call", via: "pip" }, NOW - 800),
    nowMs: NOW,
  });
  assert.equal(inPip.inPictureInPicture, true);
  assert.equal(inPip.source, "call-state");
});

test("arm: unknown, lobby, left or a stale tracker fall back to presence for both answers", () => {
  const fresh = NOW - 800;
  for (const call of [
    { phase: "unknown", via: "tab", windowHandle: 5555 },
    { phase: "lobby", via: "tab", windowHandle: 5555 },
    { phase: "left", via: "tab", windowHandle: 5555 },
    { phase: "unknown", via: null },
    { phase: "in-call", via: "tab" },
    { phase: "in-call", via: "tab", windowHandle: 0 },
  ]) {
    assert.deepEqual(
      meetWindowForArm({ sighting: presence(2222), call, latest: agree(call, fresh), nowMs: NOW }),
      { windowHandle: 2222, inPictureInPicture: false, unsettled: false, source: "presence" },
      JSON.stringify(call),
    );
  }
  // An in-call tab reading whose last read is too old, or that never read at all.
  const call = { phase: "in-call", via: "tab", windowHandle: 5555 };
  assert.equal(
    meetWindowForArm({ sighting: presence(2222), call, latest: agree(call, NOW - CALL_READ_FRESH_MS - 1), nowMs: NOW }).windowHandle,
    2222,
  );
  assert.equal(meetWindowForArm({ sighting: presence(2222), call, latest: null, nowMs: NOW }).windowHandle, 2222);
  // Presence on PiP refuses; so does a tracker that last said PiP, even a stale one (B18).
  assert.equal(
    meetWindowForArm({ sighting: presence(3333, "pip"), call: { phase: "unknown", via: null }, latest: agree({ phase: "unknown", via: null }, fresh), nowMs: NOW })
      .inPictureInPicture,
    true,
  );
  assert.equal(
    meetWindowForArm({ sighting: presence(2222), call: { phase: "in-call", via: "pip" }, latest: null, nowMs: NOW })
      .inPictureInPicture,
    true,
  );
  // No handle anywhere, or a bad one.
  assert.equal(meetWindowForArm({ sighting: presence(null), call: { phase: "unknown", via: null }, latest: null, nowMs: NOW }).windowHandle, null);
  assert.equal(meetWindowForArm({ sighting: presence(-4), call: { phase: "unknown", via: null }, latest: null, nowMs: NOW }).windowHandle, null);
});

test("geometry: PowerShell 5.1's wrapped-array shape is read like a plain array", () => {
  const raw = restored();
  const wrapped = { ...raw, doc: { value: raw.doc, Count: 4 } };
  assert.ok(sameMeetWindowGeometry(parseMeetWindowGeometry(wrapped), parseMeetWindowGeometry(raw)));
});

test("arm: a committed in-call state the latest read doubts is refused, not leaned on (#56 review 1)", () => {
  const call = { phase: "in-call", via: "tab", windowHandle: 5555 };
  // The Meet tab was switched away from: the newest reads say `unknown` (no surface) and await
  // their ~2 s of confirmation; the window 5555 may already show another tab.
  for (const latest of [
    { phase: "unknown", via: null, atMs: NOW - 300 },
    { phase: "unknown", via: "tab", windowHandle: 5555, atMs: NOW - 300 },
    { phase: "left", via: "tab", windowHandle: 5555, atMs: NOW - 300 },
  ]) {
    assert.deepEqual(
      meetWindowForArm({ sighting: presence(5555), call, latest, nowMs: NOW }),
      { windowHandle: null, inPictureInPicture: false, unsettled: true, source: "call-state" },
      JSON.stringify(latest),
    );
  }
  // Committed PiP doubted by the latest read: refused as well (and never as a capturable window).
  const pipCall = { phase: "in-call", via: "pip" };
  const pipDoubted = meetWindowForArm({ sighting: presence(2222), call: pipCall, latest: { phase: "unknown", via: null, atMs: NOW - 300 }, nowMs: NOW });
  assert.equal(pipDoubted.unsettled, true);
  assert.equal(pipDoubted.windowHandle, null);
  // The latest reading agrees: the committed window is used, as before.
  assert.deepEqual(meetWindowForArm({ sighting: presence(2222), call, latest: agree(call, NOW - 300), nowMs: NOW }), {
    windowHandle: 5555,
    inPictureInPicture: false,
    unsettled: false,
    source: "call-state",
  });
  // A stale doubting reading is no longer the tracker's word: presence answers, as for any stale tracker.
  assert.equal(
    meetWindowForArm({ sighting: presence(2222), call, latest: { phase: "unknown", via: null, atMs: NOW - CALL_READ_FRESH_MS - 1 }, nowMs: NOW })
      .source,
    "presence",
  );
});

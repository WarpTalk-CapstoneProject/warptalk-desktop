import test from "node:test";
import assert from "node:assert/strict";

import { meetWindowHandleForArm, parseMeetWindowGeometry, sameMeetWindowGeometry } from "../meet-window-geometry.ts";

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

test("arm handle: the tab's window as the call state names it wins over the older sighting", () => {
  // A Meet tab dragged out into a new window: the tracker already reads 5555, presence still 2222.
  const call = { phase: "in-call", via: "tab", windowHandle: 5555 };
  assert.equal(meetWindowHandleForArm({ sightingHandle: 2222, call }), 5555);
  assert.equal(meetWindowHandleForArm({ sightingHandle: 2222, call: { ...call, phase: "unknown" } }), 5555);
  assert.equal(meetWindowHandleForArm({ sightingHandle: 2222, call: { ...call, phase: "lobby" } }), 5555);
});

test("arm handle: PiP, a left page, no handle or a bad one fall back to the sighting", () => {
  const sightingHandle = 2222;
  assert.equal(meetWindowHandleForArm({ sightingHandle, call: { phase: "in-call", via: "pip", windowHandle: 3333 } }), 2222);
  assert.equal(meetWindowHandleForArm({ sightingHandle, call: { phase: "left", via: "tab", windowHandle: 5555 } }), 2222);
  assert.equal(meetWindowHandleForArm({ sightingHandle, call: { phase: "unknown", via: null } }), 2222);
  for (const windowHandle of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(meetWindowHandleForArm({ sightingHandle, call: { phase: "in-call", via: "tab", windowHandle } }), 2222);
  }
  assert.equal(meetWindowHandleForArm({ sightingHandle: null, call: { phase: "unknown", via: null } }), null);
});

test("geometry: PowerShell 5.1's wrapped-array shape is read like a plain array", () => {
  const raw = restored();
  const wrapped = { ...raw, doc: { value: raw.doc, Count: 4 } };
  assert.ok(sameMeetWindowGeometry(parseMeetWindowGeometry(wrapped), parseMeetWindowGeometry(raw)));
});

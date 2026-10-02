import test from "node:test";
import assert from "node:assert/strict";

import { RendererCrashGuard, windowBackgroundColor } from "../renderer-recovery.ts";

function guardAt(times, options = { maxReloads: 2, windowMs: 60_000 }) {
  let i = 0;
  return new RendererCrashGuard(options, () => times[Math.min(i++, times.length - 1)]);
}

test("a crashed page is reloaded, not left as a blank window", () => {
  // WT-930: the window went white after End and stayed white until the user quit from the tray.
  const guard = guardAt([1_000]);
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
});

test("every way a page process dies by accident gets the reload", () => {
  for (const reason of ["crashed", "oom", "killed", "abnormal-exit", "launch-failed"]) {
    assert.equal(new RendererCrashGuard().decide(reason, { isQuitting: false }), "reload", reason);
  }
});

test("a clean exit and a quit are not crashes", () => {
  const guard = new RendererCrashGuard();
  assert.equal(guard.decide("clean-exit", { isQuitting: false }), "ignore");
  // Quitting kills the renderers on purpose; reloading one would fight the quit.
  assert.equal(guard.decide("killed", { isQuitting: true }), "ignore");
});

test("a page that keeps dying is not reloaded in a loop", () => {
  const guard = guardAt([0, 5_000, 10_000, 15_000]);
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
  assert.equal(guard.decide("crashed", { isQuitting: false }), "give-up");
  // Still inside the window: still given up.
  assert.equal(guard.decide("crashed", { isQuitting: false }), "give-up");
});

test("crashes far apart each get their reload", () => {
  const guard = guardAt([0, 30_000, 120_000, 125_000]);
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
  // The first two have aged out of the window.
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
  assert.equal(guard.decide("oom", { isQuitting: false }), "reload");
});

test("the user's own Reload after a give-up starts the count again", () => {
  const guard = guardAt([0, 1_000, 2_000, 3_000]);
  guard.decide("crashed", { isQuitting: false });
  guard.decide("crashed", { isQuitting: false });
  assert.equal(guard.decide("crashed", { isQuitting: false }), "give-up");
  guard.reset();
  assert.equal(guard.decide("crashed", { isQuitting: false }), "reload");
});

test("the window ground matches the web app's canvas, never a bare white", () => {
  assert.equal(windowBackgroundColor(false), "#f1f2f4");
  assert.equal(windowBackgroundColor(true), "#050506");
});

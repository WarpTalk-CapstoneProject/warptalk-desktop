import test from "node:test";
import assert from "node:assert/strict";

import { SignedOutMeetPrompt, SIGNED_OUT_GRACE_MS } from "../signed-out-meet-prompt.ts";

/** A prompt with recorded effects and a hand-cranked grace timer. */
function harness() {
  const calls = [];
  const timers = new Map();
  let next = 1;
  const prompt = new SignedOutMeetPrompt({
    armWatcher: () => calls.push("arm"),
    disarmWatcher: () => calls.push("disarm"),
    notify: (code) => calls.push(`notify:${code}`),
    setTimer: (cb, ms) => {
      const id = next++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const elapse = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const { cb } of pending) cb();
  };
  return { prompt, calls, timers, elapse };
}

const inMeet = (meetCode = "abc-defg-hij") => ({ meetWindowVisible: true, meetCode, observedAtMs: 1 });

test("the grace period is the documented ten seconds", () => {
  const { prompt, timers } = harness();
  prompt.pageLoaded();
  assert.equal([...timers.values()][0].ms, SIGNED_OUT_GRACE_MS);
  assert.equal(SIGNED_OUT_GRACE_MS, 10_000);
});

test("a page that never arms the sensor gets main's watcher once the grace period passes", () => {
  const { prompt, calls, elapse } = harness();
  prompt.pageLoadStarted();
  prompt.pageLoaded();
  assert.deepEqual(calls, [], "nothing before the grace period: a signed-in shell may still be mounting");
  elapse();
  assert.deepEqual(calls, ["arm"]);
  assert.equal(prompt.active, true);
});

test("a web app that arms within the grace period is left alone", () => {
  const { prompt, calls, elapse } = harness();
  prompt.pageLoaded();
  prompt.webArmedWatcher();
  elapse();
  assert.deepEqual(calls, []);
  assert.equal(prompt.active, false);
});

test("an explicit signed-out report arms at once, without waiting out the grace period", () => {
  const { prompt, calls } = harness();
  prompt.pageLoaded();
  prompt.reportSignedIn(false);
  assert.deepEqual(calls, ["arm"]);
});

test("an explicit signed-in report keeps main out even after the grace period", () => {
  const { prompt, calls, elapse } = harness();
  prompt.pageLoaded();
  prompt.reportSignedIn(true);
  elapse();
  assert.deepEqual(calls, []);
});

test("one notification per Meet code, however often it is seen", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.presence(inMeet("aaa-bbbb-ccc"));
  prompt.presence({ meetWindowVisible: false, observedAtMs: 2 });
  prompt.presence(inMeet("aaa-bbbb-ccc"));
  prompt.presence(inMeet("ddd-eeee-fff"));
  assert.deepEqual(calls, ["arm", "notify:aaa-bbbb-ccc", "notify:ddd-eeee-fff"]);
});

test("a sighting without a code, or with no Meet at all, prompts nothing", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.presence({ meetWindowVisible: true, observedAtMs: 1 });
  prompt.presence({ meetWindowVisible: false, observedAtMs: 2 });
  assert.deepEqual(calls, ["arm"]);
});

test("sightings reported while the web app owns the watcher never prompt", () => {
  const { prompt, calls } = harness();
  prompt.webArmedWatcher();
  prompt.presence(inMeet());
  assert.deepEqual(calls, []);
});

test("signing in stops main's watcher and the prompts with it", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.reportSignedIn(true);
  prompt.presence(inMeet());
  assert.deepEqual(calls, ["arm", "disarm"]);
  assert.equal(prompt.active, false);
});

test("the web app arming takes the watcher over without it being pulled out from under it", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.webArmedWatcher();
  prompt.presence(inMeet());
  assert.deepEqual(calls, ["arm"], "no disarm: the web app's trigger is using the same watcher now");
  assert.equal(prompt.active, false);
});

test("an arm by the web app counts as signed in when it never reported", () => {
  const { prompt, calls, elapse } = harness();
  prompt.pageLoaded();
  prompt.webArmedWatcher();
  // An older web app disarming on its own schedule must not turn into a sign-in prompt.
  prompt.webDisarmedWatcher();
  elapse();
  assert.deepEqual(calls, []);
});

test("signing out after the web app disarmed brings main's watcher back", () => {
  const { prompt, calls } = harness();
  prompt.webArmedWatcher();
  prompt.webDisarmedWatcher();
  prompt.reportSignedIn(false);
  assert.deepEqual(calls, ["arm"]);
});

test("a full page load forgets the old page's word and starts the grace period again", () => {
  const { prompt, calls, elapse } = harness();
  prompt.pageLoaded();
  prompt.webArmedWatcher();
  // Signed out: the page reloads onto /login and nothing arms there.
  prompt.pageLoadStarted();
  prompt.pageLoaded();
  assert.deepEqual(calls, []);
  elapse();
  assert.deepEqual(calls, ["arm"]);
});

test("a page load while main is watching stands it down until the new page has had its chance", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.pageLoadStarted();
  assert.deepEqual(calls, ["arm", "disarm"]);
});

test("the dedupe outlives page loads: the same call is never announced twice", () => {
  const { prompt, calls } = harness();
  prompt.reportSignedIn(false);
  prompt.presence(inMeet("same-call-xyz"));
  prompt.pageLoadStarted();
  prompt.reportSignedIn(false);
  prompt.presence(inMeet("same-call-xyz"));
  assert.deepEqual(calls.filter((c) => c.startsWith("notify")), ["notify:same-call-xyz"]);
});

test("dispose cancels a pending grace timer", () => {
  const { prompt, timers, calls } = harness();
  prompt.pageLoaded();
  prompt.dispose();
  assert.equal(timers.size, 0);
  assert.deepEqual(calls, []);
});

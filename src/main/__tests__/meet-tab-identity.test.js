import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TAB_CONFIRM_MS,
  MEET_SURFACE_SCRIPT,
  MeetCallStateTracker,
  buttonsFromUiaTree,
  parseMeetSurfaces,
} from "../meet-call-state.ts";
import {
  MEET_TAB_SCRIPT,
  MeetTabWatch,
  formatMeetTabWatch,
  judgeMeetTab,
  judgeMeetTabs,
  parseMeetTabChecks,
  parseMeetTabRef,
} from "../meet-tab-identity.ts";
import { SENSOR_SCRIPT } from "../meet-url-sensor.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8").replace(/^﻿/, ""));

const CODE = "hqw-cmis-waa";
const HWND = 5573260;
const PID = 6224;
const RID_A = `42.${HWND}.4.0.0.643`;
const RID_B = `42.${HWND}.4.0.0.687`;

const IN_CALL_BUTTONS = buttonsFromUiaTree(load("meet-live-2026-10-02/meet-s2a-incall-1.json"));

/** The in-call Meet tab as the helper reports it, with the selected TabItem of its window. */
function meetTab({ rid = RID_A, hwnd = HWND, code = CODE, title = "Meet - hqw-cmis-waa" } = {}) {
  return {
    surface: "tab",
    meetCode: code,
    processId: PID,
    windowHandle: hwnd,
    buttons: IN_CALL_BUTTONS,
    ...(rid ? { tab: { runtimeId: rid, title } } : {}),
  };
}

function pipSurface() {
  const pip = load("meet-live-2026-10-02/meet-pip-handwritten.json");
  return parseMeetSurfaces([pip.micOn])[0];
}

function identity(overrides = {}) {
  return {
    meetCode: CODE,
    windowHandle: HWND,
    processId: PID,
    runtimeId: RID_A,
    lastTitle: "Meet - hqw-cmis-waa",
    seen: 2,
    atMs: 1000,
    ...overrides,
  };
}

/** What the helper reports for a remembered tab; by default: the window is there, the tab is not. */
function check(overrides = {}) {
  return {
    meetCode: CODE,
    windowHandle: HWND,
    runtimeId: RID_A,
    processAlive: true,
    windowAlive: true,
    minimized: false,
    strip: "ok",
    present: false,
    selected: false,
    active: "url",
    activeCode: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// One remembered tab: every row of the table
// ---------------------------------------------------------------------------------------------

test("judge: TabItem missing from a readable strip, window and browser alive -> tab-closed", () => {
  assert.deepEqual(judgeMeetTab(identity(), check()), { gone: true, reason: "tab-closed" });
});

test("judge: TabItem present but not selected -> still open in the background, never gone", () => {
  assert.deepEqual(judgeMeetTab(identity(), check({ present: true, selected: false })), {
    gone: false,
    reason: "tab-in-background",
  });
  // Whatever the active document is: a background Meet tab is a Meet tab.
  assert.equal(judgeMeetTab(identity(), check({ present: true, selected: false, active: "none" })).gone, false);
});

test("judge: TabItem present and selected, address not Meet -> tab-navigated", () => {
  assert.deepEqual(judgeMeetTab(identity(), check({ present: true, selected: true, active: "url" })), {
    gone: true,
    reason: "tab-navigated",
  });
  // Another meeting in the same tab is also this meeting left.
  assert.deepEqual(
    judgeMeetTab(identity(), check({ present: true, selected: true, active: "url", activeCode: "abc-defg-hij" })),
    { gone: true, reason: "tab-navigated" },
  );
});

test("judge: selected tab still on this meeting's address is not gone (a read caught mid-update)", () => {
  assert.deepEqual(judgeMeetTab(identity(), check({ present: true, selected: true, activeCode: CODE })), {
    gone: false,
    reason: "tab-still-meet",
  });
});

test("judge: selected tab with no readable address (reloading, blank) cannot tell", () => {
  assert.deepEqual(judgeMeetTab(identity(), check({ present: true, selected: true, active: "none" })), {
    gone: false,
    reason: "document-unreadable",
  });
});

test("judge: window gone -> window-closed; browser process gone -> browser-gone (wins)", () => {
  assert.deepEqual(judgeMeetTab(identity(), check({ windowAlive: false, strip: "unreadable" })), {
    gone: true,
    reason: "window-closed",
  });
  assert.deepEqual(judgeMeetTab(identity(), check({ processAlive: false, windowAlive: false, strip: "unreadable" })), {
    gone: true,
    reason: "browser-gone",
  });
});

test("judge: minimised window, or a strip that cannot be read (F11, app window), is never gone", () => {
  // Edge empties its tab strip while minimised (measured): no TabItem must not read as "closed".
  assert.deepEqual(judgeMeetTab(identity(), check({ minimized: true, strip: "unreadable" })), {
    gone: false,
    reason: "window-minimized",
  });
  assert.deepEqual(judgeMeetTab(identity(), check({ minimized: true, strip: "ok" })), {
    gone: false,
    reason: "window-minimized",
  });
  assert.deepEqual(judgeMeetTab(identity(), check({ strip: "unreadable" })), {
    gone: false,
    reason: "tab-strip-unreadable",
  });
});

test("judge: no answer from the helper for this tab is no evidence", () => {
  assert.deepEqual(judgeMeetTab(identity(), undefined), { gone: false, reason: "tab-check-missing" });
});

// ---------------------------------------------------------------------------------------------
// Every remembered tab of one meeting
// ---------------------------------------------------------------------------------------------

test("judge all: nothing remembered -> no opinion (the read stays no-meet-surface)", () => {
  assert.equal(judgeMeetTabs([], [check()], true), null);
});

test("judge all: a look over only some windows decides nothing (the tab may have been dragged)", () => {
  assert.deepEqual(judgeMeetTabs([identity()], [check()], false), {
    meetCode: CODE,
    left: false,
    reason: "tab-check-partial",
    tabs: [],
  });
});

test("judge all: one tab, gone -> left with the meeting's code", () => {
  assert.deepEqual(judgeMeetTabs([identity()], [check()], true), {
    meetCode: CODE,
    left: true,
    reason: "tab-closed",
    tabs: [`${RID_A}:tab-closed`],
  });
});

test("judge all: two tabs of the same meeting - left only when NEITHER remains", () => {
  const a = identity({ runtimeId: RID_A, atMs: 1000 });
  const b = identity({ runtimeId: RID_B, atMs: 2000 });
  const goneA = check({ runtimeId: RID_A });
  const bInBackground = check({ runtimeId: RID_B, present: true, selected: false });
  assert.equal(judgeMeetTabs([a, b], [goneA, bInBackground], true).left, false);
  assert.equal(judgeMeetTabs([a, b], [goneA, bInBackground], true).reason, "tab-in-background");
  // Both gone: the reason of the tab seen last.
  const bNavigated = check({ runtimeId: RID_B, present: true, selected: true, active: "url" });
  assert.deepEqual(judgeMeetTabs([a, b], [goneA, bNavigated], true), {
    meetCode: CODE,
    left: true,
    reason: "tab-navigated",
    tabs: [`${RID_A}:tab-closed`, `${RID_B}:tab-navigated`],
  });
});

test("judge all: a check is matched by RuntimeId AND window, never by RuntimeId alone", () => {
  const other = check({ windowHandle: 999, present: true, selected: false });
  assert.equal(judgeMeetTabs([identity()], [other], true).reason, "tab-check-missing");
});

test("judge all: 'still there' outranks 'cannot tell' in the reason given", () => {
  const a = identity({ runtimeId: RID_A });
  const b = identity({ runtimeId: RID_B, windowHandle: 777 });
  const verdict = judgeMeetTabs(
    [a, b],
    [check({ runtimeId: RID_A, strip: "unreadable" }), check({ runtimeId: RID_B, windowHandle: 777, present: true })],
    true,
  );
  assert.equal(verdict.left, false);
  assert.equal(verdict.reason, "tab-in-background");
});

// ---------------------------------------------------------------------------------------------
// Remembering tabs
// ---------------------------------------------------------------------------------------------

const sighting = (rid, extra = {}) => ({
  meetCode: CODE,
  windowHandle: HWND,
  processId: PID,
  tab: rid ? { runtimeId: rid, title: "Meet" } : undefined,
  ...extra,
});

test("remember: a tab is remembered after two reads in a row, not one", () => {
  const watch = new MeetTabWatch();
  assert.deepEqual(watch.record([sighting(RID_A)], 1), []);
  assert.deepEqual(watch.watchList(CODE), []);
  const confirmed = watch.record([sighting(RID_A)], 2);
  assert.equal(confirmed.length, 1);
  assert.deepEqual(watch.watchList(CODE), [{ meetCode: CODE, windowHandle: HWND, processId: PID, runtimeId: RID_A }]);
  // Reported once, not on every later read.
  assert.deepEqual(watch.record([sighting(RID_A)], 3), []);
});

test("remember: one read caught mid tab switch (another tab selected) is forgotten, not remembered", () => {
  const watch = new MeetTabWatch();
  watch.record([sighting(RID_A)], 1);
  watch.record([sighting(RID_A)], 2);
  watch.record([sighting(RID_B)], 3); // the race: the strip was read after the user switched
  watch.record([sighting(RID_A)], 4);
  watch.record([sighting(RID_A)], 5);
  assert.deepEqual(
    watch.watchList(CODE).map((e) => e.runtimeId),
    [RID_A],
  );
});

test("remember: a surface without a readable strip, handle or process remembers nothing", () => {
  const watch = new MeetTabWatch();
  for (let i = 0; i < 3; i++) {
    watch.record([sighting(null), sighting(RID_A, { windowHandle: null }), sighting(RID_B, { processId: null })], i);
  }
  assert.deepEqual(watch.all, []);
});

test("remember: reads without any tab surface (PiP, nothing) keep what is remembered", () => {
  const watch = new MeetTabWatch();
  watch.record([sighting(RID_A)], 1);
  watch.record([sighting(RID_A)], 2);
  watch.record([], 3);
  assert.equal(watch.watchList(CODE).length, 1);
});

test("remember: another meeting in a tab drops the old meeting's tabs", () => {
  const watch = new MeetTabWatch();
  watch.record([sighting(RID_A)], 1);
  watch.record([sighting(RID_A)], 2);
  watch.record([sighting(RID_B, { meetCode: "abc-defg-hij" })], 3);
  assert.deepEqual(watch.watchList(CODE), []);
});

test("remember: the same tab now on another meeting starts over", () => {
  const watch = new MeetTabWatch();
  watch.record([sighting(RID_A)], 1);
  watch.record([sighting(RID_A)], 2);
  watch.record([sighting(RID_A, { meetCode: "abc-defg-hij" })], 3);
  assert.equal(watch.all[0].seen, 1);
  assert.deepEqual(watch.watchList("abc-defg-hij"), []);
});

// ---------------------------------------------------------------------------------------------
// The helper's answers, defensively
// ---------------------------------------------------------------------------------------------

test("parse: the selected tab of a tab surface; never for PiP; malformed RuntimeIds dropped", () => {
  const [tab, pip] = parseMeetSurfaces([
    { surface: "tab", meetCode: CODE, processId: PID, windowHandle: HWND, buttons: [], tab: { rid: RID_A, title: "Meet - x" } },
    { surface: "pip", meetCode: CODE, processId: PID, buttons: [], tab: { rid: RID_A, title: "x" } },
  ]);
  assert.deepEqual(tab.tab, { runtimeId: RID_A, title: "Meet - x" });
  assert.equal(pip.tab, undefined);
  assert.equal(parseMeetTabRef({ rid: "42;rm -rf", title: "x" }), null);
  assert.equal(parseMeetTabRef({ rid: 42 }), null);
  assert.equal(parseMeetTabRef(null), null);
  assert.equal(parseMeetTabRef({ rid: RID_A, title: "x".repeat(500) }).title.length, 123);
});

test("parse: tab checks - one-element collapse, and a missing flag is a broken answer, not false", () => {
  const raw = {
    code: CODE,
    hwnd: HWND,
    rid: RID_A,
    processAlive: true,
    windowAlive: true,
    minimized: false,
    strip: "ok",
    present: false,
    selected: false,
    active: "url",
    activeCode: null,
  };
  assert.deepEqual(parseMeetTabChecks(raw), [check()]);
  assert.deepEqual(parseMeetTabChecks([raw, raw]).length, 2);
  for (const key of ["processAlive", "windowAlive", "minimized", "present", "selected"]) {
    const { [key]: _drop, ...rest } = raw;
    assert.deepEqual(parseMeetTabChecks([rest]), [], key);
  }
  assert.deepEqual(parseMeetTabChecks([{ ...raw, strip: "maybe" }]), []);
  assert.deepEqual(parseMeetTabChecks([{ ...raw, active: "meet" }]), []);
  assert.deepEqual(parseMeetTabChecks([{ ...raw, code: "not a code" }]), []);
  assert.deepEqual(parseMeetTabChecks([{ ...raw, hwnd: -1 }]), []);
  assert.deepEqual(parseMeetTabChecks([{ ...raw, activeCode: "nope" }])[0].activeCode, null);
  assert.deepEqual(parseMeetTabChecks(null), []);
});

test("watch list: what is sent to the helper is only well-formed ASCII entries", () => {
  assert.equal(
    formatMeetTabWatch([
      { meetCode: CODE, windowHandle: HWND, processId: PID, runtimeId: RID_A },
      { meetCode: "x;y", windowHandle: HWND, processId: PID, runtimeId: RID_A },
      { meetCode: CODE, windowHandle: HWND, processId: PID, runtimeId: "1,2" },
      { meetCode: CODE, windowHandle: HWND, processId: 0, runtimeId: RID_B },
    ]),
    `${CODE},${HWND},${PID},${RID_A}`,
  );
  assert.equal(formatMeetTabWatch([]), "");
});

// ---------------------------------------------------------------------------------------------
// The tracker: debounce, the payload, and the no-overwrite rule
// ---------------------------------------------------------------------------------------------

function tracker(overrides = {}) {
  const clock = { ms: 10_000 };
  const calls = [];
  const tabEvents = [];
  const instance = new MeetCallStateTracker({
    probe: async () => [],
    emitCallState: (state) => calls.push(state),
    emitSelfMic: () => undefined,
    onTabEvent: (event) => tabEvents.push(event),
    now: () => clock.ms,
    setTimer: () => "timer",
    clearTimer: () => undefined,
    ...overrides,
  });
  return { instance, clock, calls, tabEvents };
}

/** In the call in tab A, read twice so the tab is remembered. */
function inCall(t, tab = {}) {
  t.instance.ingest([meetTab(tab)], { full: true, tabChecks: [] });
  t.clock.ms += 1000;
  t.instance.ingest([meetTab(tab)], { full: true, tabChecks: [] });
  assert.equal(t.instance.callState.phase, "in-call");
}

const closed = (overrides = {}) => ({ full: true, tabChecks: [check(overrides)] });

test("tracker: the incident - Meet tab closed -> left / tab-closed with the meeting's code, after two full looks 3 s apart", () => {
  const t = tracker();
  inCall(t);
  assert.deepEqual(t.instance.tabWatchList, [{ meetCode: CODE, windowHandle: HWND, processId: PID, runtimeId: RID_A }]);

  t.clock.ms += 1000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "in-call", "one look is not enough");
  t.clock.ms += 1500;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "in-call", "two looks 1.5 s apart are not enough for a tab verdict");
  t.clock.ms += 1500;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "left");
  // The exact payload the web app gets on bridge:meet-call-state.
  assert.deepEqual(t.calls.at(-1), { phase: "left", via: "tab", meetCode: CODE, reason: "tab-closed", atMs: t.clock.ms });
  assert.equal(DEFAULT_TAB_CONFIRM_MS, 3000);
  // Nothing more to watch: the verdict is in.
  assert.deepEqual(t.instance.tabWatchList, []);
});

test("tracker: the 3 s presence look alone (fast loop off) carries the verdict", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "left");
  assert.equal(t.instance.callState.reason, "tab-closed");
});

test("tracker: left / tab-closed is not overwritten by later surface-less or failed reads", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  const emitted = t.calls.length;
  for (let i = 0; i < 5; i++) {
    t.clock.ms += 3000;
    t.instance.ingest([]); // no checks any more: the helper is not asked
    t.clock.ms += 1000;
    t.instance.ingestFailure();
  }
  assert.equal(t.instance.callState.phase, "left");
  assert.equal(t.instance.callState.reason, "tab-closed");
  assert.equal(t.calls.length, emitted, "nothing re-emitted, nothing undone");
});

test("tracker: after the verdict, Meet seen again (same or another call) takes over at once", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([meetTab({ rid: RID_B })], { full: true, tabChecks: [] });
  assert.equal(t.instance.callState.phase, "in-call");
  // ...and from there a surface-less read is plain unknown again, no stale verdict.
  t.clock.ms += 1000;
  t.instance.ingest([], { full: true, tabChecks: [] });
  t.clock.ms += 2000;
  t.instance.ingest([], { full: true, tabChecks: [] });
  assert.equal(t.instance.callState.phase, "unknown");
  assert.equal(t.instance.callState.reason, "no-meet-surface", "tab B was seen once only: nothing remembered");
});

test("tracker: tab switched away (Meet tab in the background) is never left", () => {
  const t = tracker();
  inCall(t);
  for (let i = 0; i < 6; i++) {
    t.clock.ms += 3000;
    t.instance.ingest([], closed({ present: true, selected: false }));
  }
  assert.equal(t.instance.callState.phase, "unknown");
  assert.equal(t.instance.callState.reason, "tab-in-background");
  assert.equal(t.instance.callState.meetCode, null, "an unknown stays code-less, as before");
  assert.ok(!t.calls.some((c) => c.phase === "left"));
});

test("tracker: minimised / F11 / unreadable strip is never left", () => {
  for (const overrides of [{ minimized: true }, { strip: "unreadable" }, { present: true, selected: true, active: "none" }]) {
    const t = tracker();
    inCall(t);
    for (let i = 0; i < 6; i++) {
      t.clock.ms += 3000;
      t.instance.ingest([], closed(overrides));
    }
    assert.equal(t.instance.callState.phase, "unknown", JSON.stringify(overrides));
  }
});

test("tracker: window closed, browser quit, tab navigated away -> left with that reason", () => {
  for (const [overrides, reason] of [
    [{ windowAlive: false, strip: "unreadable" }, "window-closed"],
    [{ processAlive: false, windowAlive: false, strip: "unreadable" }, "browser-gone"],
    [{ present: true, selected: true, active: "url" }, "tab-navigated"],
  ]) {
    const t = tracker();
    inCall(t);
    t.clock.ms += 3000;
    t.instance.ingest([], closed(overrides));
    t.clock.ms += 3000;
    t.instance.ingest([], closed(overrides));
    assert.deepEqual(
      { phase: t.instance.callState.phase, reason: t.instance.callState.reason, meetCode: t.instance.callState.meetCode },
      { phase: "left", reason, meetCode: CODE },
    );
  }
});

test("tracker: a look over only some windows never yields left", () => {
  const t = tracker();
  inCall(t);
  for (let i = 0; i < 6; i++) {
    t.clock.ms += 3000;
    t.instance.ingest([], { full: false, tabChecks: [check()] });
  }
  assert.equal(t.instance.callState.phase, "unknown");
  assert.equal(t.instance.callState.reason, "tab-check-partial");
});

test("tracker: an older caller with no tab evidence behaves exactly as before", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([]);
  t.clock.ms += 3000;
  t.instance.ingest([]);
  assert.equal(t.instance.callState.phase, "unknown");
});

test("tracker: a tab in mid-drag or reloading - one gone read then Meet again - does not fire", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 1000;
  t.instance.ingest([], closed());
  t.clock.ms += 1000;
  // Dropped into another window: the full scan finds the meeting there, new handle.
  t.instance.ingest([meetTab({ hwnd: 4242, rid: "42.4242.4.0.0.9" })], { full: true, tabChecks: [] });
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "in-call");
  assert.ok(!t.calls.some((c) => c.phase === "left"));
});

test("tracker: a gone read interrupted by an unsure one restarts the count", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed({ strip: "unreadable" }));
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.notEqual(t.instance.callState.phase, "left");
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "left");
});

test("tracker: a PiP window for the call is in-call - the tab verdict is never reached", () => {
  const t = tracker();
  inCall(t);
  for (let i = 0; i < 4; i++) {
    t.clock.ms += 3000;
    t.instance.ingest([pipSurface()], closed());
  }
  assert.equal(t.instance.callState.phase, "in-call");
  assert.equal(t.instance.callState.via, "pip");
  // PiP closed and the tab really gone: now it may be said.
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "left");
  assert.equal(t.instance.callState.meetCode, CODE);
});

test("tracker: two tabs of the same meeting - closing one keeps the call", () => {
  const t = tracker();
  inCall(t, { rid: RID_A });
  t.clock.ms += 1000;
  t.instance.ingest([meetTab({ rid: RID_B, hwnd: 777 })], { full: true, tabChecks: [] });
  t.clock.ms += 1000;
  t.instance.ingest([meetTab({ rid: RID_B, hwnd: 777 }), meetTab({ rid: RID_A })], { full: true, tabChecks: [] });
  t.clock.ms += 1000;
  t.instance.ingest([meetTab({ rid: RID_B, hwnd: 777 }), meetTab({ rid: RID_A })], { full: true, tabChecks: [] });
  assert.equal(t.instance.tabWatchList.length, 2);
  const aGoneBBackground = {
    full: true,
    tabChecks: [check({ runtimeId: RID_A }), check({ runtimeId: RID_B, windowHandle: 777, present: true })],
  };
  for (let i = 0; i < 4; i++) {
    t.clock.ms += 3000;
    t.instance.ingest([], aGoneBBackground);
  }
  assert.notEqual(t.instance.callState.phase, "left");
});

test("tracker: main.log hears of a remembered tab once, and of each verdict change once", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 1000;
  t.instance.ingest([meetTab()], { full: true, tabChecks: [] });
  assert.deepEqual(
    t.tabEvents.map((e) => e.kind),
    ["identity"],
  );
  assert.equal(t.tabEvents[0].identity.runtimeId, RID_A);
  for (let i = 0; i < 3; i++) {
    t.clock.ms += 1000;
    t.instance.ingest([], closed({ present: true }));
  }
  t.clock.ms += 1000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  const verdicts = t.tabEvents.filter((e) => e.kind === "verdict");
  assert.deepEqual(
    verdicts.map((v) => `${v.left ? "left" : "unknown"}/${v.reason}`),
    ["unknown/tab-in-background", "left/tab-closed"],
  );
  assert.deepEqual(verdicts[1].tabs, [`${RID_A}:tab-closed`]);
});

test("tracker: reset forgets the remembered tabs and the verdict", () => {
  const t = tracker();
  inCall(t);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.instance.reset();
  assert.equal(t.instance.callState.reason, "not-watching");
  assert.deepEqual(t.instance.tabWatchList, []);
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  t.clock.ms += 3000;
  t.instance.ingest([], closed());
  assert.equal(t.instance.callState.phase, "unknown");
});

test("tracker: the fast loop's probe may answer with tab evidence", async () => {
  let reads = 0;
  const t = tracker({
    probe: async () => {
      reads += 1;
      return reads <= 2 ? { surfaces: [meetTab()], full: false, tabChecks: [] } : { surfaces: [], ...closed() };
    },
  });
  t.instance.setPolling(true); // the first read is in flight
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 6; i++) {
    t.clock.ms += 1000;
    await t.instance.tick();
  }
  assert.equal(t.instance.callState.phase, "left");
  assert.equal(t.instance.callState.reason, "tab-closed");
});

// ---------------------------------------------------------------------------------------------
// The helper script
// ---------------------------------------------------------------------------------------------

test("the tab script is pure ASCII, has no backtick, and is spliced into the helper", () => {
  assert.doesNotMatch(MEET_TAB_SCRIPT, /[^\x00-\x7f]/);
  assert.doesNotMatch(MEET_TAB_SCRIPT, /`/);
  assert.ok(SENSOR_SCRIPT.includes(MEET_TAB_SCRIPT));
  assert.ok(SENSOR_SCRIPT.indexOf(MEET_SURFACE_SCRIPT) < SENSOR_SCRIPT.indexOf(MEET_TAB_SCRIPT));
  const cls = SENSOR_SCRIPT.slice(SENSOR_SCRIPT.indexOf("public class MeetWin"), SENSOR_SCRIPT.indexOf("'@"));
  assert.ok(cls.includes("IsWindow(IntPtr h)"));
});

test("the tab script only reads: no select, invoke, focus, keys, close or scroll", () => {
  assert.doesNotMatch(
    MEET_TAB_SCRIPT,
    /\.Select\(|InvokePattern|SetFocus|SendKeys|SendWait|TogglePattern|ScrollIntoView|ExpandCollapse|CloseWindow|PostMessage|SendMessage|ShowWindow/,
  );
});

test("the tab strip is taken only from outside every Document, and a minimised window is not read", () => {
  const find = MEET_TAB_SCRIPT.slice(MEET_TAB_SCRIPT.indexOf("function Find-TabStrip"));
  assert.match(find, /Test-InDocument \$t \$el/);
  const read = MEET_TAB_SCRIPT.slice(MEET_TAB_SCRIPT.indexOf("function Read-TabStrip"));
  assert.ok(read.indexOf("IsIconic") < read.indexOf("Find-TabStrip"));
  // An empty strip is unreadable, not "every tab closed".
  assert.match(read, /if \(\$items\.Count -eq 0\) \{ return \$null \}/);
});

test("the helper checks remembered tabs only after a full pass, and records each surface's selected tab", () => {
  assert.match(SENSOR_SCRIPT, /if \(\$scan\.full -and \$spec\.Length -gt 0\)/);
  assert.match(MEET_SURFACE_SCRIPT, /Get-SelectedTab \$w \$el/);
  assert.match(MEET_SURFACE_SCRIPT, /Read-MeetScan @\(\$script:surfaceWindows\) \$false/);
  assert.match(MEET_SURFACE_SCRIPT, /Read-MeetScan \(Get-BrowserWindows\) \$true/);
});

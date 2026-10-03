import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEET_SURFACE_SCRIPT,
  GEOMETRY_HOLD_MS,
  MeetCallStateTracker,
  buttonsFromUiaTree,
  classifyMeetCall,
  classifyMeetSurface,
  parseMeetSurfaces,
  sightingFromScan,
} from "../meet-call-state.ts";
import { meetWindowForArm } from "../meet-window-geometry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8").replace(/^﻿/, ""));

/**
 * A dumped Meet tab as the surface the helper would return for it. The dumps hold the Document
 * subtree but not its address, so the room code is taken from the document's own name
 * ("Meet - <code>"), which is what the tab showed when it was dumped.
 */
function tabSurface(name, overrides = {}) {
  const root = load(name);
  const code = /^Meet - ([a-z-]+)$/.exec(root.name)?.[1];
  assert.ok(code, `${name}: no room code in the document name`);
  return { surface: "tab", meetCode: code, processId: 4242, buttons: buttonsFromUiaTree(root), ...overrides };
}

const LIVE = "meet-live-2026-10-02/";
const pip = () => load(`${LIVE}meet-pip-handwritten.json`);

/** The same buttons with every class token scrambled: what a Meet release that renames them does. */
function renamedClasses(surface) {
  return {
    ...surface,
    buttons: surface.buttons.map((b) => ({
      n: b.n,
      c: b.c
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => (/[[\]:/#]/.test(token) ? token : `zz${[...token].reverse().join("")}`))
        .join(" "),
    })),
  };
}

/** The same buttons in a language the vocabulary does not hold. */
function unknownLanguage(surface) {
  return { ...surface, buttons: surface.buttons.map((b, i) => ({ n: `Schaltfläche ${i}`, c: b.c })) };
}

// ---------------------------------------------------------------------------------------------
// The four live dumps (2026-10-02, Chrome, vi UI)
// ---------------------------------------------------------------------------------------------

test("lobby: a mic button and no Leave button is the green room, not the call", () => {
  const { call, mic } = classifyMeetCall([tabSurface(`${LIVE}meet-s1-lobby-1.json`)]);
  assert.deepEqual(call, { phase: "lobby", via: "tab", meetCode: "hqw-cmis-waa", reason: "mic-button-no-leave" });
  assert.deepEqual(mic, { muted: false, stale: false, via: "class" });
});

test("in call, mic on: the Leave button's class says in-call, the mic's class says unmuted", () => {
  const { call, mic } = classifyMeetCall([tabSurface(`${LIVE}meet-s2a-incall-1.json`)]);
  assert.deepEqual(call, { phase: "in-call", via: "tab", meetCode: "hqw-cmis-waa", reason: "leave-button-class" });
  assert.deepEqual(mic, { muted: false, stale: false, via: "class" });
});

test("in call, mic muted: the camera is still ON in this dump and must not be read as the mic", () => {
  const surface = tabSurface(`${LIVE}meet-s2b-muted-1.json`);
  // The trap: the camera carries the same "on" token the mic would.
  const camera = surface.buttons.find((b) => b.n === "Tắt máy ảnh");
  assert.match(camera.c, /\baLTxue\b/);
  const { call, mic } = classifyMeetCall([surface]);
  assert.equal(call.phase, "in-call");
  assert.deepEqual(mic, { muted: true, stale: false, via: "class" });
});

test("left: the address is still the meeting's, and it is not a call", () => {
  const { call, mic } = classifyMeetCall([tabSurface(`${LIVE}meet-s4-left-1.json`)]);
  assert.deepEqual(call, { phase: "left", via: "tab", meetCode: "csk-fzok-ssx", reason: "rejoin-button" });
  assert.deepEqual(mic, { muted: null, stale: false, via: null });
});

// ---------------------------------------------------------------------------------------------
// Picture-in-picture (hand-written surface; see the fixture's own comment)
// ---------------------------------------------------------------------------------------------

test("the picture-in-picture window is the call, with its room code", () => {
  const { call, mic } = classifyMeetCall(parseMeetSurfaces([pip().micOn]));
  assert.deepEqual(call, { phase: "in-call", via: "pip", meetCode: "hqw-cmis-waa", reason: "leave-button-class" });
  assert.deepEqual(mic, { muted: false, stale: false, via: "class" });
});

test("muting inside the picture-in-picture window is read like the tab", () => {
  const { call, mic } = classifyMeetCall(parseMeetSurfaces([pip().micMuted]));
  assert.equal(call.phase, "in-call");
  assert.deepEqual(mic, { muted: true, stale: false, via: "class" });
});

test("a window that only has the PiP title is not Meet", () => {
  // The title is written by a page. Without a call control inside, it proves nothing.
  const bare = { surface: "pip", meetCode: "abc-defg-hij", processId: 1, buttons: [{ n: "OK", c: "btn" }] };
  assert.equal(classifyMeetCall([bare]).call.phase, "unknown");
  assert.equal(sightingFromScan(null, [bare]), null);
});

// ---------------------------------------------------------------------------------------------
// The older dumps must not regress
// ---------------------------------------------------------------------------------------------

for (const name of ["meet-tree-vi-captions-on.json", "meet-tree-vi-captions-multi.json"]) {
  test(`older dump ${name}: in call, mic on`, () => {
    const { call, mic } = classifyMeetCall([tabSurface(name)]);
    assert.deepEqual(call, { phase: "in-call", via: "tab", meetCode: "ffo-iwfp-dgw", reason: "leave-button-class" });
    // CC is ON in these dumps and its button carries neither toggle token; it must not disturb
    // the mic read.
    assert.deepEqual(mic, { muted: false, stale: false, via: "class" });
  });
}

// ---------------------------------------------------------------------------------------------
// The fallback tier, and degrading instead of guessing
// ---------------------------------------------------------------------------------------------

test("Meet renames its classes: the names still give the phase and the mute", () => {
  const incall = classifyMeetCall([renamedClasses(tabSurface(`${LIVE}meet-s2a-incall-1.json`))]);
  assert.equal(incall.call.phase, "in-call");
  assert.equal(incall.call.reason, "leave-button-name");
  assert.deepEqual(incall.mic, { muted: false, stale: false, via: "name" });

  const muted = classifyMeetCall([renamedClasses(tabSurface(`${LIVE}meet-s2b-muted-1.json`))]);
  assert.deepEqual(muted.mic, { muted: true, stale: false, via: "name" });

  const lobby = classifyMeetCall([renamedClasses(tabSurface(`${LIVE}meet-s1-lobby-1.json`))]);
  assert.equal(lobby.call.phase, "lobby");

  const left = classifyMeetCall([renamedClasses(tabSurface(`${LIVE}meet-s4-left-1.json`))]);
  assert.equal(left.call.phase, "left");
});

test("an unknown language: the classes still give the phase and the mute", () => {
  const incall = classifyMeetCall([unknownLanguage(tabSurface(`${LIVE}meet-s2a-incall-1.json`))]);
  assert.equal(incall.call.reason, "leave-button-class");
  assert.deepEqual(incall.mic, { muted: false, stale: false, via: "class" });

  const muted = classifyMeetCall([unknownLanguage(tabSurface(`${LIVE}meet-s2b-muted-1.json`))]);
  assert.deepEqual(muted.mic, { muted: true, stale: false, via: "class" });

  const lobby = classifyMeetCall([unknownLanguage(tabSurface(`${LIVE}meet-s1-lobby-1.json`))]);
  assert.equal(lobby.call.phase, "lobby");

  // No Rejoin label to recognise: the post-call page's own button classes say "left".
  const left = classifyMeetCall([unknownLanguage(tabSurface(`${LIVE}meet-s4-left-1.json`))]);
  assert.deepEqual(left.call, { phase: "left", via: "tab", meetCode: "csk-fzok-ssx", reason: "left-page-class" });
});

// ---------------------------------------------------------------------------------------------
// "left" needs positive evidence (bug 2026-10-03, desktop 0.4.11: LiveKit dropped, Meet read as
// "left" with reason no-call-controls, the bridge capture stopped while the user was in the call)
// ---------------------------------------------------------------------------------------------

test("no recognisable call controls is unknown, never left", () => {
  const incall = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  const variants = {
    // A tree caught mid-rebuild, or Meet's reconnecting overlay: a couple of unrelated buttons.
    "partial tree": [{ n: "Dismiss", c: "mUIrbf-LgbsSe" }, { n: "", c: "VfPpkd-Bz112c-LgbsSe" }],
    // Only the extension's injected buttons came back (they never count as Meet's).
    "extension buttons only": incall.buttons.filter((b) => /[[\]:/#]/.test(b.c.split(/\s+/)[0] ?? "")),
    // The toolbar is gone from the tree, everything else is still there.
    "toolbar stripped": incall.buttons.filter((b) => !/\bVYBDae-Bz112c-LgbsSe\b/.test(b.c)),
  };
  for (const [label, buttons] of Object.entries(variants)) {
    assert.ok(buttons.length > 0, `${label}: the variant must not be the empty-tree case`);
    const { call, mic } = classifyMeetCall([{ ...incall, buttons }]);
    assert.deepEqual({ phase: call.phase, reason: call.reason }, { phase: "unknown", reason: "no-call-controls" }, label);
    assert.equal(mic.muted, null, label);
  }
});

test("the post-call page in an unknown language AND with renamed classes is unknown, not guessed", () => {
  const { call } = classifyMeetCall([unknownLanguage(renamedClasses(tabSurface(`${LIVE}meet-s4-left-1.json`)))]);
  assert.deepEqual({ phase: call.phase, reason: call.reason }, { phase: "unknown", reason: "no-call-controls" });
});

test("the post-call page is recognised by its Return to home screen button alone", () => {
  for (const n of ["Quay lại màn hình chính", "Return to home screen"]) {
    const surface = { surface: "tab", meetCode: "abc-defg-hij", processId: 1, buttons: [{ n, c: "zz1" }, { n: "Feedback", c: "zz2" }] };
    assert.deepEqual({ phase: classifyMeetCall([surface]).call.phase, reason: classifyMeetCall([surface]).call.reason }, {
      phase: "left",
      reason: "return-home-button",
    }, n);
  }
});

test("a post-call button inside a live, unreadable toolbar is not the post-call page", () => {
  const toolbar = unknownLanguage(renamedClasses(tabSurface(`${LIVE}meet-s2a-incall-1.json`)));
  const buttons = [...toolbar.buttons, { n: "Rejoin", c: "zz" }];
  assert.equal(classifyMeetCall([{ ...toolbar, buttons }]).call.reason, "controls-unrecognised");
});

test("tracker: a long run of reads without controls (WarpTalk reconnecting) never ends the call", () => {
  const { instance, clock, calls, mics } = tracker();
  instance.ingest(incallMuted());
  const noControls = [{ surface: "tab", meetCode: "hqw-cmis-waa", processId: 4242, buttons: [{ n: "Dismiss", c: "mUIrbf-LgbsSe" }] }];
  for (let i = 0; i < 40; i++) {
    clock.ms += 1000;
    instance.ingest(noControls);
  }
  assert.ok(calls.every((c) => c.phase !== "left"), JSON.stringify(calls.map((c) => c.phase)));
  assert.equal(instance.callState.phase, "unknown");
  // The mic is kept (stale), not cleared as it would be for a real leave.
  assert.deepEqual({ muted: mics.at(-1).muted, stale: mics.at(-1).stale }, { muted: true, stale: true });
  // Controls back: in the call again on the first read.
  clock.ms += 1000;
  instance.ingest(incallMuted());
  assert.equal(instance.callState.phase, "in-call");
});

test("renamed classes AND an unknown language: unknown, never 'left'", () => {
  // The case that must not end a meeting: the toolbar is there, and nothing here can read it.
  for (const name of ["meet-s2a-incall-1.json", "meet-s2b-muted-1.json", "meet-s1-lobby-1.json"]) {
    const { call, mic } = classifyMeetCall([unknownLanguage(renamedClasses(tabSurface(LIVE + name)))]);
    assert.deepEqual(
      { phase: call.phase, reason: call.reason },
      { phase: "unknown", reason: "controls-unrecognised" },
      name,
    );
    assert.equal(mic.muted, null, name);
  }
});

test("a mic button whose name and class contradict each other is not decided", () => {
  const surface = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  const buttons = surface.buttons.map((b) => (b.n === "Tắt micrô" ? { n: "Bật micrô", c: b.c } : b));
  const { call, mic } = classifyMeetCall([{ ...surface, buttons }]);
  assert.equal(call.phase, "in-call");
  assert.deepEqual(mic, { muted: null, stale: false, via: null });
});

test("without a known mic name, a first toggle that is the camera is not taken for the mic", () => {
  const surface = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  const buttons = surface.buttons.filter((b) => b.n !== "Tắt micrô");
  const { call, mic } = classifyMeetCall([{ ...surface, buttons }]);
  assert.equal(call.phase, "in-call");
  assert.equal(mic.muted, null);
});

test("a button an extension injected cannot pose as Meet's mic or Leave button", () => {
  const left = tabSurface(`${LIVE}meet-s4-left-1.json`);
  const posing = [
    { n: "Rời khỏi cuộc gọi", c: "min-h-[50px] RnWvU flex" },
    { n: "Tắt micrô", c: "hover:bg-[#202225] aLTxue" },
  ];
  const { call } = classifyMeetCall([{ ...left, buttons: [...left.buttons, ...posing] }]);
  assert.equal(call.phase, "left");
});

test("a tab whose tree has not been read yet is unknown, not left", () => {
  const empty = { surface: "tab", meetCode: "abc-defg-hij", processId: 1, buttons: [] };
  assert.deepEqual(classifyMeetSurface(empty).call.reason, "empty-tree");
  assert.equal(classifyMeetSurface(empty).call.phase, "unknown");
});

test("a listing cut short is unknown when the controls were not in the part that arrived", () => {
  const left = tabSurface(`${LIVE}meet-s4-left-1.json`, { truncated: true });
  assert.equal(classifyMeetCall([left]).call.reason, "listing-truncated");
  // Controls that did arrive are still believed.
  const incall = tabSurface(`${LIVE}meet-s2a-incall-1.json`, { truncated: true });
  assert.equal(classifyMeetCall([incall]).call.phase, "in-call");
});

test("no Meet surface at all is unknown: a background tab is invisible, not gone", () => {
  assert.deepEqual(classifyMeetCall([]).call, {
    phase: "unknown",
    via: null,
    meetCode: null,
    reason: "no-meet-surface",
  });
});

test("a minimized window is read but its mic value is flagged stale", () => {
  const { mic } = classifyMeetCall([tabSurface(`${LIVE}meet-s2b-muted-1.json`, { minimized: true })]);
  assert.deepEqual(mic, { muted: true, stale: true, via: "class" });
});

test("the call wins over a 'you left' tab of another meeting", () => {
  const left = tabSurface(`${LIVE}meet-s4-left-1.json`);
  const [inPip] = parseMeetSurfaces([pip().micMuted]);
  const { call, mic } = classifyMeetCall([left, inPip]);
  assert.deepEqual({ phase: call.phase, via: call.via, meetCode: call.meetCode }, {
    phase: "in-call",
    via: "pip",
    meetCode: "hqw-cmis-waa",
  });
  assert.equal(mic.muted, true);
});

// ---------------------------------------------------------------------------------------------
// What presence is told
// ---------------------------------------------------------------------------------------------

test("presence: the PiP window is a sighting with the room code, though its document is about:blank", () => {
  const surfaces = parseMeetSurfaces([pip().micOn]);
  // The URL read found nothing: about:blank, and no origin label on this Chrome.
  assert.deepEqual(sightingFromScan(null, surfaces), { meetCode: "hqw-cmis-waa", processId: 4242, via: "pip" });
  // Nor does it lose the code when the URL read did find the origin label (which carries none).
  assert.deepEqual(sightingFromScan({ meetCode: null, processId: 4242, via: "pip" }, surfaces), {
    meetCode: "hqw-cmis-waa",
    processId: 4242,
    via: "pip",
  });
});

test("presence: a 'you left' page stays a sighting - the phase travels beside it, not instead", () => {
  const sighting = { meetCode: "csk-fzok-ssx", processId: 4242, via: "document" };
  assert.deepEqual(sightingFromScan(sighting, [tabSurface(`${LIVE}meet-s4-left-1.json`)]), sighting);
});

test("presence: the in-call surface's window handle replaces the URL read's (WT-910 recording)", () => {
  // The URL read preferred the normal window; the call itself is in the PiP window.
  const [inPip] = parseMeetSurfaces([{ ...pip().micOn, windowHandle: 3333 }]);
  assert.equal(inPip.windowHandle, 3333);
  assert.deepEqual(sightingFromScan({ meetCode: null, processId: 4242, windowHandle: 2222, via: "document" }, [inPip]), {
    meetCode: "hqw-cmis-waa",
    processId: 4242,
    windowHandle: 3333,
    via: "pip",
  });
  // A malformed handle is dropped, not trusted.
  for (const windowHandle of [0, -1, 1.5, "3333", null]) {
    const [surface] = parseMeetSurfaces([{ ...pip().micOn, windowHandle }]);
    assert.equal("windowHandle" in surface, false);
  }
});

test("presence: the helper reports each surface's window handle", () => {
  assert.match(MEET_SURFACE_SCRIPT, /windowHandle = \$w\.H\.ToInt64\(\)/);
});

test("presence: nothing seen stays nothing seen", () => {
  assert.equal(sightingFromScan(null, []), null);
});

test("helper output is parsed defensively", () => {
  // ConvertTo-Json collapses one-element arrays; a bad code or surface kind is dropped.
  const one = parseMeetSurfaces({ surface: "tab", meetCode: "abc-defg-hij", processId: 7, buttons: { n: "x", c: "y" } });
  assert.deepEqual(one, [
    { surface: "tab", meetCode: "abc-defg-hij", processId: 7, minimized: false, truncated: false, buttons: [{ n: "x", c: "y" }] },
  ]);
  assert.deepEqual(parseMeetSurfaces(null), []);
  assert.deepEqual(parseMeetSurfaces([{ surface: "tab", meetCode: "../etc", buttons: [] }]), []);
  assert.deepEqual(parseMeetSurfaces([{ surface: "window", meetCode: "abc-defg-hij", buttons: [] }]), []);
  assert.equal(parseMeetSurfaces([{ surface: "pip", meetCode: "abc-defg-hij", processId: -1 }])[0].processId, null);
});

// ---------------------------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------------------------

function tracker(overrides = {}) {
  const clock = { ms: 10_000 };
  const calls = [];
  const mics = [];
  const instance = new MeetCallStateTracker({
    probe: async () => [],
    emitCallState: (state) => calls.push(state),
    emitSelfMic: (mic) => mics.push(mic),
    now: () => clock.ms,
    setTimer: () => "timer",
    clearTimer: () => undefined,
    ...overrides,
  });
  return { instance, clock, calls, mics };
}

const incallOn = () => [tabSurface(`${LIVE}meet-s2a-incall-1.json`)];
const incallMuted = () => [tabSurface(`${LIVE}meet-s2b-muted-1.json`)];
const leftPage = () => [tabSurface(`${LIVE}meet-s4-left-1.json`, { meetCode: "hqw-cmis-waa" })];

test("tracker: joining is reported on the first read, and only once", () => {
  const { instance, calls, mics } = tracker();
  assert.equal(instance.callState.phase, "unknown");
  assert.equal(instance.callState.reason, "not-watching");

  instance.ingest(incallOn());
  instance.ingest(incallOn());
  instance.ingest(incallOn());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { phase: "in-call", via: "tab", meetCode: "hqw-cmis-waa", reason: "leave-button-class", atMs: 10_000 });
  assert.equal(mics.length, 1);
  assert.deepEqual(mics[0], { muted: false, stale: false, via: "class", meetCode: "hqw-cmis-waa", atMs: 10_000 });
  assert.deepEqual(instance.callState, calls[0]);
  assert.deepEqual(instance.selfMic, mics[0]);
});

test("tracker: a mute is reported once it has held for a second (the next fast read)", () => {
  const { instance, clock, calls, mics } = tracker();
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(incallMuted());
  assert.equal(calls.length, 1, "the phase did not change");
  assert.equal(mics.length, 1, "one read of a change is held, not applied");
  clock.ms += 1000;
  instance.ingest(incallMuted());
  assert.deepEqual(mics.at(-1), { muted: true, stale: false, via: "class", meetCode: "hqw-cmis-waa", atMs: 12_000 });
  clock.ms += 1000;
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(incallOn());
  assert.equal(mics.at(-1).muted, false);
  assert.equal(mics.length, 3);
});

// ---------------------------------------------------------------------------------------------
// Field log 2026-10-03 (desktop 0.4.11, vi UI): Meet's button unmuted, WarpTalk told "muted"
// ---------------------------------------------------------------------------------------------

test("field 09:20:12: muted / unmuted / muted 436 ms apart is a flap, and the unmuted value stands", () => {
  // The log's three answers within 2.2 s. One read in between that disagrees (the two cadences,
  // or a tree caught mid-update) must not move the WarpTalk mic.
  const { instance, clock, mics } = tracker();
  instance.ingest(incallOn());
  const before = mics.length;
  clock.ms += 1000;
  instance.ingest(incallMuted()); // 09:20:12.539
  clock.ms += 436;
  instance.ingest(incallOn()); // 09:20:12.975
  clock.ms += 1756;
  instance.ingest(incallOn()); // 09:20:14.731 would have been the next flip
  assert.equal(mics.length, before, "nothing was emitted: the mute never held");
  assert.equal(instance.selfMic.muted, false);
});

test("a contradictory read in the middle of a pending mute restarts the hold", () => {
  const { instance, clock, mics } = tracker();
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(incallMuted());
  clock.ms += 500;
  instance.ingest([]); // Meet out of sight for one read: the streak is broken
  clock.ms += 600;
  instance.ingest(incallMuted());
  assert.equal(instance.selfMic.muted, false, "1.1 s since the first muted read, but not held throughout");
  clock.ms += 1000;
  instance.ingest(incallMuted());
  assert.equal(instance.selfMic.muted, true);
  assert.equal(mics.at(-1).stale, false);
});

test("the first reading of a meeting is applied at once, not held", () => {
  const { instance, mics } = tracker();
  instance.ingest(incallMuted());
  assert.deepEqual(
    { muted: mics.at(-1).muted, stale: mics.at(-1).stale },
    { muted: true, stale: false },
  );
});

/** Two surfaces of the same call: the tab of one window and another window's tab (or PiP). */
function twoSurfaces(first, second) {
  return [first, { ...second, processId: 5151, windowHandle: 9090 }];
}

test("two surfaces of the same call that disagree: unknown, never whichever comes first", () => {
  // classifyMeetCall used to take the first in-call surface's mic. The presence look lists windows
  // in z-order and the fast read in the previous look's order, so the answer followed focus.
  const muted = tabSurface(`${LIVE}meet-s2b-muted-1.json`, { meetCode: "hqw-cmis-waa" });
  const on = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  for (const surfaces of [twoSurfaces(muted, on), twoSurfaces(on, muted)]) {
    const { call, mic, micEvidence } = classifyMeetCall(surfaces);
    assert.equal(call.phase, "in-call");
    assert.deepEqual(mic, { muted: null, stale: false, via: null });
    assert.equal(micEvidence.rule, "surfaces-conflict");
    assert.equal(micEvidence.surfaces.length, 2);
  }
  // The sticky window (development's preferWindowHandle) chooses the window, never the mic.
  const sticky = classifyMeetCall(twoSurfaces({ ...on, windowHandle: 7070 }, muted), { preferWindowHandle: 9090 });
  assert.equal(sticky.call.windowHandle, 9090, "the reported window is the preferred one");
  assert.equal(sticky.mic.muted, null);
  // And a tab plus the PiP window of the same call, disagreeing for one read.
  const [inPip] = parseMeetSurfaces([pip().micMuted]);
  assert.equal(classifyMeetCall([on, inPip]).mic.muted, null);
  // Agreeing surfaces still answer.
  const [pipOn] = parseMeetSurfaces([pip().micOn]);
  assert.deepEqual(classifyMeetCall([on, pipOn]).mic, { muted: false, stale: false, via: "class" });
});

test("tracker: two disagreeing surfaces keep the applied value (stale), never flip it to muted", () => {
  const { instance, clock, mics } = tracker();
  instance.ingest(incallOn());
  const muted = tabSurface(`${LIVE}meet-s2b-muted-1.json`, { meetCode: "hqw-cmis-waa" });
  for (let i = 0; i < 4; i++) {
    clock.ms += 1000;
    instance.ingest(twoSurfaces(muted, incallOn()[0]));
  }
  assert.ok(mics.every((m) => m.muted !== true), JSON.stringify(mics));
  assert.deepEqual({ muted: instance.selfMic.muted, stale: instance.selfMic.stale }, { muted: false, stale: true });
});

test("no known mic label: a red button outside the call controls is not read as 'you are muted'", () => {
  // The people panel and the tiles come before the toolbar in document order. With a mic label the
  // vocabulary does not hold (another language, or a label Meet has not been seen to use), the
  // position tier took the first toggle-styled button anywhere - a red one there read as muted.
  const surface = unknownLanguage(tabSurface(`${LIVE}meet-s2a-incall-1.json`));
  const panelButton = { n: "Schaltfläche panel", c: "pYTkkf-Bz112c-LgbsSe JAUIm Y3DJRd humMQc" };
  const { call, mic, micEvidence } = classifyMeetCall([{ ...surface, buttons: [panelButton, ...surface.buttons] }]);
  assert.equal(call.phase, "in-call");
  assert.equal(mic.muted, null);
  assert.equal(micEvidence.rule, "position-not-call-control");
  // Without that button the toolbar's mic is still found by position.
  assert.deepEqual(classifyMeetCall([surface]).micEvidence.rule, "position");
});

test("a mic label and a class that disagree are never reported as muted (label says on, class says off)", () => {
  // The other direction of the existing contradiction test: Meet's label is "Turn off microphone"
  // (live) while the class carries the red token - e.g. a warning style on a live mic.
  const surface = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  const buttons = surface.buttons.map((b) =>
    b.n === "Tắt micrô" ? { n: b.n, c: b.c.replace("aLTxue", "Y3DJRd") } : b,
  );
  const { mic, micEvidence } = classifyMeetCall([{ ...surface, buttons }]);
  assert.deepEqual(mic, { muted: null, stale: false, via: null });
  assert.deepEqual(
    { rule: micEvidence.rule, byLabel: micEvidence.byLabel, byClass: micEvidence.byClass, label: micEvidence.label },
    { rule: "label-class-conflict", byLabel: "on", byClass: "off", label: "Tắt micrô" },
  );
});

test("English labels decide the state too", () => {
  const surface = tabSurface(`${LIVE}meet-s2a-incall-1.json`);
  const en = { "Tắt micrô": "Turn off microphone (ctrl + d)", "Rời khỏi cuộc gọi": "Leave call" };
  const buttons = surface.buttons.map((b) => (en[b.n] ? { n: en[b.n], c: b.c } : b));
  const { mic, micEvidence } = classifyMeetCall([{ ...surface, buttons }]);
  assert.deepEqual(mic, { muted: false, stale: false, via: "class" });
  assert.equal(micEvidence.rule, "label+class");
});

test("main.log evidence: what was read, once per change, with the outcome", () => {
  const reads = [];
  const emitted = [];
  const { instance, clock } = tracker({
    onMicRead: (read) => reads.push(read),
    emitSelfMic: (mic, read) => emitted.push({ mic, read }),
  });
  instance.ingest(incallOn());
  instance.ingest(incallOn()); // same evidence: not logged again
  clock.ms += 1000;
  instance.ingest(incallMuted());
  clock.ms += 1000;
  instance.ingest(incallMuted());
  assert.deepEqual(
    reads.map((r) => [r.outcome, r.rule, r.label, r.byLabel, r.byClass]),
    [
      ["applied", "label+class", "Tắt micrô", "on", "on"],
      ["held", "label+class", "Bật micrô", "off", "off"],
      ["applied", "label+class", "Bật micrô", "off", "off"],
    ],
  );
  assert.match(reads[0].classes, /\baLTxue\b/);
  // The emitted value carries the deciding read for the log line.
  assert.equal(emitted.at(-1).mic.muted, true);
  assert.equal(emitted.at(-1).read.label, "Bật micrô");
  assert.equal(emitted.at(-1).read.surface, "tab");
});

test("main.log evidence: a dropped flap is logged as such", () => {
  const reads = [];
  const { instance, clock } = tracker({ onMicRead: (read) => reads.push(read) });
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(incallMuted());
  clock.ms += 400;
  instance.ingest(incallOn());
  assert.deepEqual(reads.map((r) => r.outcome), ["applied", "held", "dropped"]);
});

test("tracker: one 'left' read does not end the call - a re-render must not flap it", () => {
  const { instance, clock, calls } = tracker();
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(leftPage());
  assert.equal(instance.callState.phase, "in-call");
  clock.ms += 1000;
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest(leftPage());
  assert.equal(instance.callState.phase, "in-call", "the streak was broken by the read in between");
  assert.equal(calls.length, 1);
});

test("tracker: 'left' needs two reads AND time between them", () => {
  const { instance, clock, calls, mics } = tracker();
  instance.ingest(incallMuted());
  clock.ms += 1000;
  // The presence look and the fast read can land together: two reads, no time.
  instance.ingest(leftPage());
  clock.ms += 20;
  instance.ingest(leftPage());
  assert.equal(instance.callState.phase, "in-call");
  clock.ms += 1480;
  instance.ingest(leftPage());
  assert.equal(instance.callState.phase, "left");
  assert.equal(calls.at(-1).reason, "rejoin-button");
  // The call is over: no mic value survives it.
  assert.deepEqual(mics.at(-1), { muted: null, stale: false, via: null, meetCode: "hqw-cmis-waa", atMs: clock.ms });
});

test("tracker: Meet out of sight keeps the last mic value and marks it stale", () => {
  const { instance, clock, calls, mics } = tracker();
  instance.ingest(incallMuted());
  clock.ms += 1000;
  instance.ingest([]);
  assert.equal(instance.callState.phase, "in-call", "one empty read is the tab-switch gap");
  assert.equal(instance.selfMic.stale, false);
  clock.ms += 2000;
  instance.ingest([]);
  assert.deepEqual(calls.at(-1), { phase: "unknown", via: null, meetCode: null, reason: "no-meet-surface", atMs: clock.ms });
  assert.deepEqual(mics.at(-1), { muted: true, stale: true, via: "class", meetCode: "hqw-cmis-waa", atMs: clock.ms });

  // Back in sight, in the PiP window, still muted: fresh again.
  clock.ms += 1000;
  instance.ingest(parseMeetSurfaces([pip().micMuted]));
  assert.equal(calls.at(-1).via, "pip");
  assert.deepEqual(mics.at(-1), { muted: true, stale: false, via: "class", meetCode: "hqw-cmis-waa", atMs: clock.ms });
});

test("tracker: tab to picture-in-picture is one change of 'via', with no gap reported", () => {
  const { instance, clock, calls } = tracker();
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingest([]); // the moment between the tab hiding and Chrome raising the PiP window
  clock.ms += 1000;
  instance.ingest(parseMeetSurfaces([pip().micOn]));
  assert.deepEqual(calls.map((c) => `${c.phase}/${c.via}`), ["in-call/tab", "in-call/pip"]);
});

test("tracker: a stale mic value is not carried into another meeting", () => {
  const { instance, clock, mics } = tracker();
  instance.ingest(incallMuted());
  clock.ms += 1000;
  // Another meeting's page, in a state with no readable mic.
  const other = { surface: "tab", meetCode: "abc-defg-hij", processId: 1, buttons: [] };
  instance.ingest([other]);
  clock.ms += 2000;
  instance.ingest([other]);
  assert.deepEqual(mics.at(-1), { muted: null, stale: false, via: null, meetCode: "abc-defg-hij", atMs: clock.ms });
});

test("tracker: failed reads need confirming too, and never read as 'left'", () => {
  const { instance, clock } = tracker();
  instance.ingest(incallOn());
  clock.ms += 1000;
  instance.ingestFailure();
  assert.equal(instance.callState.phase, "in-call");
  clock.ms += 2000;
  instance.ingestFailure();
  assert.equal(instance.callState.phase, "unknown");
  assert.equal(instance.callState.reason, "probe-failed");
  assert.deepEqual({ muted: instance.selfMic.muted, stale: instance.selfMic.stale }, { muted: false, stale: true });
});

test("tracker: reset says 'not watching' at once and stops the fast loop", async () => {
  let probes = 0;
  const timers = [];
  const { instance, calls } = tracker({
    probe: async () => {
      probes += 1;
      return incallOn();
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });
  instance.setPolling(true);
  instance.setPolling(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1, "arming twice starts one loop");
  assert.equal(instance.callState.phase, "in-call");
  assert.equal(timers.length, 1);

  instance.reset();
  assert.equal(instance.isPolling, false);
  assert.deepEqual(
    { phase: calls.at(-1).phase, reason: calls.at(-1).reason },
    { phase: "unknown", reason: "not-watching" },
  );
  // The timer that was pending belongs to a loop nobody runs any more.
  timers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
});

test("tracker: a probe that rejects is a failed read, and the loop goes on", async () => {
  const timers = [];
  const { instance } = tracker({
    probe: async () => {
      throw new Error("helper died");
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });
  instance.setPolling(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(instance.callState.reason, "probe-failed");
  instance.reset();
});

test("tracker: without a sensor (macOS, Linux) it says so and never polls", () => {
  const { instance, calls } = tracker({ probe: null });
  assert.equal(instance.callState.reason, "unsupported-platform");
  instance.setPolling(true);
  assert.equal(instance.isPolling, false);
  instance.reset();
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The helper script fragment
// ---------------------------------------------------------------------------------------------

test("the surface script is pure ASCII and has no backtick", () => {
  // PowerShell 5.1 reads a BOM-less script as ANSI; a backtick would end the template literal.
  assert.doesNotMatch(MEET_SURFACE_SCRIPT, /[^\x00-\x7f]/);
  assert.doesNotMatch(MEET_SURFACE_SCRIPT, /`/);
});

test("the PiP title is matched whole and case-sensitively, and only over about:blank", () => {
  const body = MEET_SURFACE_SCRIPT.slice(MEET_SURFACE_SCRIPT.indexOf("function Get-MeetSurface"));
  assert.match(MEET_SURFACE_SCRIPT, /\$PIP_TITLE = '\^Meet - \(\[a-z\]\{3,4\}-\[a-z\]\{3,4\}-\[a-z\]\{3,4\}\)\$'/);
  const blank = body.indexOf("$value -eq 'about:blank'");
  const title = body.indexOf("-cmatch $PIP_TITLE");
  assert.notEqual(blank, -1, "the about:blank gate is gone");
  assert.notEqual(title, -1, "the title is no longer matched case-sensitively");
  assert.ok(blank < title, "the about:blank gate must come before the title is believed");
  // A tab surface needs the exact host, never a substring.
  assert.match(body, /\$uri\.Host -ne 'meet\.google\.com'/);
});

test("the helper lists buttons and nothing else: no invoke, no focus, no keys", () => {
  assert.doesNotMatch(MEET_SURFACE_SCRIPT, /InvokePattern|SetFocus|SendKeys|SendWait|TogglePattern/);
});

// ---------------------------------------------------------------------------------------------
// WT-910: the window and its layout travel with the call state (crop + re-arm on a moved tab)
// ---------------------------------------------------------------------------------------------

const RAW_GEOMETRY = {
  win: [93, 50, 1393, 857],
  efb: [100, 50, 1386, 850],
  uia: [93, 50, 1393, 857],
  doc: [100, 166, 1386, 850],
};

test("window geometry: parsed for a tab, never kept for the PiP window, dropped when it does not add up", () => {
  const [tab] = parseMeetSurfaces([{ surface: "tab", meetCode: "abc-defg-hij", processId: 7, buttons: [], geometry: RAW_GEOMETRY }]);
  assert.deepEqual(tab.geometry.content, { x: 0, y: 116, width: 1286, height: 684 });
  const [inPip] = parseMeetSurfaces([{ ...pip().micOn, geometry: RAW_GEOMETRY }]);
  assert.equal("geometry" in inPip, false);
  const [bad] = parseMeetSurfaces([
    { surface: "tab", meetCode: "abc-defg-hij", buttons: [], geometry: { ...RAW_GEOMETRY, doc: [0, 0, 5000, 5000] } },
  ]);
  assert.equal("geometry" in bad, false);
  // An older helper sends no geometry at all; the surface is exactly what it was.
  const [legacy] = parseMeetSurfaces([{ surface: "tab", meetCode: "abc-defg-hij", buttons: [] }]);
  assert.equal("geometry" in legacy, false);
});

test("window geometry: the call reading carries the window and the tab's layout, only when known", () => {
  const [tab] = parseMeetSurfaces([
    { ...tabSurface(`${LIVE}meet-s2a-incall-1.json`), windowHandle: 2222, geometry: RAW_GEOMETRY },
  ]);
  const { call } = classifyMeetSurface(tab);
  assert.equal(call.phase, "in-call");
  assert.equal(call.windowHandle, 2222);
  assert.deepEqual(call.windowGeometry.frame, { x: 0, y: 0, width: 1286, height: 800 });
  // Without them the reading has neither key: older consumers see the same object as before.
  const plain = classifyMeetSurface(tabSurface(`${LIVE}meet-s2a-incall-1.json`)).call;
  assert.equal("windowHandle" in plain, false);
  assert.equal("windowGeometry" in plain, false);
  // PiP: neither a window nor a crop (see the tab/PiP switch test below).
  const [inPip] = parseMeetSurfaces([{ ...pip().micOn, windowHandle: 3333 }]);
  const pipCall = classifyMeetSurface(inPip).call;
  assert.equal("windowHandle" in pipCall, false);
  assert.equal("windowGeometry" in pipCall, false);
});

test("tracker: a Meet tab dragged into a new window is a new call state, while still in-call", () => {
  const { instance, calls } = tracker();
  const read = (windowHandle, geometry = RAW_GEOMETRY) =>
    parseMeetSurfaces([{ ...tabSurface(`${LIVE}meet-s2a-incall-1.json`), windowHandle, geometry }]);
  instance.ingest(read(2222));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowHandle, 2222);
  instance.ingest(read(2222));
  assert.equal(calls.length, 1, "the same window and layout must not emit again");
  instance.ingest(read(5555));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].phase, "in-call");
  assert.equal(calls[1].windowHandle, 5555);
});

test("tracker: the bookmarks bar toggled is a new call state; moving the window is not", () => {
  const { instance, calls } = tracker();
  const read = (geometry) =>
    parseMeetSurfaces([{ ...tabSurface(`${LIVE}meet-s2a-incall-1.json`), windowHandle: 2222, geometry }]);
  instance.ingest(read(RAW_GEOMETRY));
  const moved = Object.fromEntries(Object.entries(RAW_GEOMETRY).map(([k, v]) => [k, v.map((n) => n + 300)]));
  instance.ingest(read(moved));
  assert.equal(calls.length, 1);
  instance.ingest(read({ ...RAW_GEOMETRY, doc: [100, 136, 1386, 850] }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].windowGeometry.content.y, 86);
});

test("the helper reads the tab's geometry fenced off: never for PiP, never able to break the answer", () => {
  const body = MEET_SURFACE_SCRIPT.slice(MEET_SURFACE_SCRIPT.indexOf("function Get-MeetSurface"));
  assert.match(body, /if \(\$kind -eq 'tab'\) \{ try \{ \$geometry = Get-MeetGeometry \$w \$doc \$el \} catch \{ \$geometry = \$null \} \}/);
  assert.match(body, /geometry = \$geometry/);
  // Infinite edges (Rect.Empty) must never reach ConvertTo-Json.
  assert.match(MEET_SURFACE_SCRIPT, /\[double\]::IsInfinity\(\$v\)/);
  assert.match(MEET_SURFACE_SCRIPT, /SetThreadDpiAwarenessContext\(\[IntPtr\]::new\(-4\)\)/);
  assert.match(MEET_SURFACE_SCRIPT, /\$DWMWA_EXTENDED_FRAME_BOUNDS = 9/);
  // The DPI calls sit in try blocks: an entry point missing on an old Windows must not kill the helper.
  for (const line of MEET_SURFACE_SCRIPT.split("\n").filter((l) => /DpiAwarenessContext\(\[IntPtr\]/.test(l))) {
    assert.match(line, /^\s*try \{/, line);
  }
});

// ---------------------------------------------------------------------------------------------
// Review of #56: tab/PiP handles, sticky window, held geometry
// ---------------------------------------------------------------------------------------------

const incallTab = (windowHandle, geometry = RAW_GEOMETRY, overrides = {}) => ({
  ...tabSurface(`${LIVE}meet-s2a-incall-1.json`),
  windowHandle,
  ...(geometry ? { geometry } : {}),
  ...overrides,
});

test("tab/PiP switch: the call state's window is the TAB's, so going to PiP and back changes nothing", () => {
  const { instance, calls } = tracker();
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  instance.ingest(parseMeetSurfaces([{ ...pip().micOn, windowHandle: 3333 }]));
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  assert.deepEqual(
    calls.map((c) => [c.via, c.windowHandle]),
    [
      ["tab", 2222],
      ["pip", undefined],
      ["tab", 2222],
    ],
  );
  // The presence sighting still names the PiP window, so the arm can refuse it (B18).
  const [inPip] = parseMeetSurfaces([{ ...pip().micOn, windowHandle: 3333 }]);
  assert.equal(sightingFromScan(null, [inPip]).windowHandle, 3333);
});

test("sticky window: two Meet windows in the same phase, a focus change does not flip the window", () => {
  const a = incallTab(2222);
  const b = incallTab(5555);
  // Z-order puts the focused window first.
  assert.equal(classifyMeetCall([a, b]).call.windowHandle, 2222);
  assert.equal(classifyMeetCall([b, a], { preferWindowHandle: 2222 }).call.windowHandle, 2222);
  // Without a preference (or one that is no longer a candidate) the first one wins, as before.
  assert.equal(classifyMeetCall([b, a]).call.windowHandle, 5555);
  assert.equal(classifyMeetCall([b, a], { preferWindowHandle: 7777 }).call.windowHandle, 5555);
  // A preference never beats a surface further into the call.
  const lobby = { ...tabSurface(`${LIVE}meet-s1-lobby-1.json`), windowHandle: 2222 };
  assert.equal(classifyMeetCall([lobby, b], { preferWindowHandle: 2222 }).call.windowHandle, 5555);

  const { instance, calls } = tracker();
  instance.ingest(parseMeetSurfaces([a, b]));
  instance.ingest(parseMeetSurfaces([b, a]));
  instance.ingest(parseMeetSurfaces([b, a]));
  assert.equal(calls.length, 1, "focusing the other window must not emit a new window");
  assert.equal(instance.callState.windowHandle, 2222);
  // The reported window goes away: the other one takes over.
  instance.ingest(parseMeetSurfaces([b]));
  assert.equal(instance.callState.windowHandle, 5555);
});

test("held geometry: a transient failed layout read keeps the last good one, no geometry-less state", () => {
  const { instance, calls, clock } = tracker();
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  const good = instance.callState.windowGeometry;
  assert.ok(good);
  // One read whose geometry failed its checks, then one with none at all.
  instance.ingest(parseMeetSurfaces([incallTab(2222, { ...RAW_GEOMETRY, doc: [0, 0, 9000, 9000] })]));
  instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  assert.equal(calls.length, 1, "no state without the layout was emitted");
  assert.deepEqual(instance.callState.windowGeometry, good);
  // A good read again restarts the hold, which is measured in time, not reads.
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  for (let elapsed = 0; elapsed < GEOMETRY_HOLD_MS; elapsed += 500) {
    clock.ms += 500;
    instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  }
  assert.equal(calls.length, 1);
  // Past the hold, it is let go.
  clock.ms += 1;
  instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  assert.equal(calls.length, 2);
  assert.equal("windowGeometry" in instance.callState, false);
});

test("held geometry: never carried to another window or through a minimized one", () => {
  const moved = tracker();
  moved.instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  moved.instance.ingest(parseMeetSurfaces([incallTab(5555, null)]));
  assert.equal(moved.instance.callState.windowHandle, 5555);
  assert.equal("windowGeometry" in moved.instance.callState, false);
  // ...and not back onto the first window either: the hold was dropped with the change.
  moved.instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  assert.equal("windowGeometry" in moved.instance.callState, false);

  const minimized = tracker();
  minimized.instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  minimized.instance.ingest(parseMeetSurfaces([incallTab(2222, null, { minimized: true })]));
  assert.equal("windowGeometry" in minimized.instance.callState, false);
  minimized.instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  assert.equal("windowGeometry" in minimized.instance.callState, false);
});

test("tracker: the time of the last read that came back, not of the last change", () => {
  const { instance, clock } = tracker();
  assert.equal(instance.lastReadAtMs, null);
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  clock.ms += 5_000;
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  assert.equal(instance.lastReadAtMs, clock.ms);
  assert.notEqual(instance.callState.atMs, clock.ms);
  instance.ingestFailure();
  assert.equal(instance.lastReadAtMs, clock.ms, "a failed read is not a read");
  instance.reset();
  assert.equal(instance.lastReadAtMs, null);
});

// ---------------------------------------------------------------------------------------------
// Review of eaddd8d: latest reading, tab-window preference, hold through PiP, one window per scan
// ---------------------------------------------------------------------------------------------

test("latest reading: a doubting read is visible before it commits, so an arm refuses (review 1)", () => {
  const { instance, clock } = tracker();
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  assert.deepEqual(instance.latestReading, { phase: "in-call", via: "tab", windowHandle: 2222, atMs: clock.ms });
  // The Meet tab switched away from (no PiP raised yet): `unknown`, not yet confirmed.
  clock.ms += 1000;
  instance.ingest([]);
  assert.equal(instance.callState.phase, "in-call", "still committed: unknown needs confirming");
  assert.deepEqual(instance.latestReading, { phase: "unknown", via: null, atMs: clock.ms });
  // The old freshness (any read within 5 s) would have handed out 2222 here.
  const arm = meetWindowForArm({
    sighting: { windowHandle: 2222, via: "document" },
    call: instance.callState,
    latest: instance.latestReading,
    nowMs: clock.ms + 100,
  });
  assert.equal(arm.unsettled, true);
  assert.equal(arm.windowHandle, null);
  // Back on the tab: agreed again, the window is handed out.
  clock.ms += 500;
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  const again = meetWindowForArm({
    sighting: { windowHandle: 9999, via: "document" },
    call: instance.callState,
    latest: instance.latestReading,
    nowMs: clock.ms + 100,
  });
  assert.deepEqual([again.windowHandle, again.unsettled, again.source], [2222, false, "call-state"]);
  // A failed read is not a reading; reset forgets it.
  instance.ingestFailure();
  assert.equal(instance.latestReading.phase, "in-call");
  instance.reset();
  assert.equal(instance.latestReading, null);
});

test("window preference: the tab's window survives a PiP / unknown stretch (review 2)", () => {
  const a = incallTab(2222);
  const b = incallTab(5555);
  const inPip = { ...pip().micOn, windowHandle: 3333 };
  const { instance, clock } = tracker();
  instance.ingest(parseMeetSurfaces([a, b]));
  assert.equal(instance.windowPreference, 2222);
  // PiP commits at once (same phase) and carries no tab window...
  instance.ingest(parseMeetSurfaces([inPip]));
  assert.equal(instance.callState.via, "pip");
  assert.equal(instance.callState.windowHandle, undefined);
  assert.equal(instance.windowPreference, 2222, "...but the preference is kept");
  // ...and so does a confirmed `unknown` with no surface at all.
  instance.ingest([]);
  clock.ms += 2000;
  instance.ingest([]);
  assert.equal(instance.callState.phase, "unknown");
  assert.equal(instance.windowPreference, 2222);
  // Back with both windows, the other one first in Z-order: still the window reported before.
  instance.ingest(parseMeetSurfaces([b, a]));
  assert.equal(instance.callState.windowHandle, 2222);
  instance.reset();
  assert.equal(instance.windowPreference, null);
});

test("held geometry: dropped when a PiP or surface-less reading commits (review 3)", () => {
  for (const away of [[{ ...pip().micOn, windowHandle: 3333 }], []]) {
    const { instance, clock } = tracker();
    instance.ingest(parseMeetSurfaces([incallTab(2222)]));
    assert.ok(instance.callState.windowGeometry);
    clock.ms += 600;
    instance.ingest(parseMeetSurfaces(away));
    if (away.length === 0) {
      // `unknown` needs confirming; until it commits the hold stays.
      clock.ms += 1600;
      instance.ingest([]);
      assert.equal(instance.callState.phase, "unknown");
    }
    // Back on the tab well inside GEOMETRY_HOLD_MS of the last good layout, but without one:
    // the layout from before the stretch is not re-applied.
    clock.ms += 200;
    instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
    assert.equal(instance.callState.via, "tab");
    assert.equal("windowGeometry" in instance.callState, false, JSON.stringify(away.map((s) => s.surface)));
  }
  // A tab reading that is `unknown` (same window) does not drop it: that is a tab reading.
  const { instance, clock } = tracker();
  instance.ingest(parseMeetSurfaces([incallTab(2222)]));
  const good = instance.callState.windowGeometry;
  clock.ms += 500;
  instance.ingest(parseMeetSurfaces([incallTab(2222, null, { buttons: [] })]));
  clock.ms += 500;
  instance.ingest(parseMeetSurfaces([incallTab(2222, null)]));
  assert.deepEqual(instance.callState.windowGeometry, good);
});

test("sighting and call state name the same window when two Meet windows tie (review 5)", () => {
  const a = incallTab(2222);
  const b = incallTab(5555);
  const { instance } = tracker();
  instance.ingest(parseMeetSurfaces([a, b]));
  // Focus moves to the other window: Z-order now lists 5555 first.
  const surfaces = parseMeetSurfaces([b, a]);
  const sighting = sightingFromScan(null, surfaces, { preferWindowHandle: instance.windowPreference });
  instance.ingest(surfaces);
  assert.equal(instance.callState.windowHandle, 2222);
  assert.equal(sighting.windowHandle, instance.callState.windowHandle);
  // Without the preference the two would have disagreed.
  assert.equal(sightingFromScan(null, surfaces).windowHandle, 5555);
});

test("the URL sensor classifies its sighting with the tracker's window preference (review 5)", () => {
  const source = readFileSync(path.join(here, "..", "meet-url-sensor.ts"), "utf8");
  assert.match(source, /sightingFromScan\(parsed\.sighting \?\? null, surfaces, \{ preferWindowHandle: this\.windowPreference\?\.\(\) \?\? null \}\)/);
  const main = readFileSync(path.join(here, "..", "index.ts"), "utf8");
  assert.match(main, /meetUrlSensor\.setWindowPreference\(\(\) => meetCallTracker\.windowPreference\)/);
});

test("the helper looks each window up once, and compiles its C# once", () => {
  assert.doesNotMatch(MEET_SURFACE_SCRIPT, /FromHandle/);
  assert.doesNotMatch(MEET_SURFACE_SCRIPT, /Add-Type @'/);
  assert.match(MEET_SURFACE_SCRIPT, /\$script:el = \$null/);
  assert.match(MEET_SURFACE_SCRIPT, /Get-MeetSurface \$w \$script:doc \$script:docValue \$script:el/);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIC_SESSION_SENSOR_SCRIPT,
  MeetMicStateStream,
  classifyMicEndpoint,
  classifySpeakerEndpoint,
  decideMeetMicState,
  sameMeetMicState,
} from "../meet-mic-state.ts";

const BROWSER = 5000;
const AUDIO_SERVICE = 5100;
const WARPTALK = 9000;
const AT = 1_700_000_000_000;

const CABLE = "CABLE Output (VB-Audio Virtual Cable)";
const REALTEK = "Microphone (Realtek(R) Audio)";
const HIFI = "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)";

/** Chrome records in its audio service, a child of the browser process. */
function chromeSession(state = "active", pid = AUDIO_SERVICE, browser = BROWSER) {
  return {
    pid,
    state,
    chain: [
      { pid, name: "chrome.exe" },
      { pid: browser, name: "chrome.exe" },
      { pid: 1200, name: "explorer.exe" },
    ],
  };
}

function warptalkSession() {
  return {
    pid: 9100,
    state: "active",
    chain: [
      { pid: 9100, name: "WarpTalk.exe" },
      { pid: WARPTALK, name: "WarpTalk.exe" },
    ],
  };
}

function endpoint(name, sessions, extra = {}) {
  const interfaceName = name.includes("(") ? name.slice(name.indexOf("(") + 1, -1) : undefined;
  return { id: `{id-${name}}`, name, interfaceName, sessions, ...extra };
}

const CONTEXT = { browserPid: BROWSER, excludePids: [WARPTALK], at: AT };

test("an active browser session on CABLE Output only reads as cable", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(REALTEK, [])] },
    CONTEXT,
  );
  assert.deepEqual(state, { at: AT, browserPid: BROWSER, state: "cable", endpoint: CABLE, endpoints: [CABLE] });
});

test("an active browser session on the real mic only reads as real", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, []), endpoint(REALTEK, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(state.state, "real");
  assert.equal(state.endpoint, REALTEK);
  assert.equal(state.browserPid, BROWSER);
});

test("active sessions on both the cable and the real mic read as ambiguous", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(REALTEK, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(state.state, "ambiguous");
  assert.equal(state.endpoint, undefined);
  assert.deepEqual(state.endpoints, [CABLE, REALTEK]);
});

test("no session at all reads as unknown", () => {
  const state = decideMeetMicState({ endpoints: [endpoint(CABLE, []), endpoint(REALTEK, [])] }, CONTEXT);
  assert.deepEqual(state, { at: AT, browserPid: BROWSER, state: "unknown", reason: "no-active-session" });
});

test("stale inactive and expired sessions are ignored", () => {
  // Chrome keeps an Inactive session on the device it stopped using until the process exits.
  const state = decideMeetMicState(
    {
      endpoints: [
        endpoint(CABLE, [chromeSession("active")]),
        endpoint(REALTEK, [chromeSession("inactive"), chromeSession("expired")]),
      ],
    },
    CONTEXT,
  );
  assert.equal(state.state, "cable");

  const onlyStale = decideMeetMicState(
    { endpoints: [endpoint(REALTEK, [chromeSession("inactive")]), endpoint(CABLE, [chromeSession("expired")])] },
    CONTEXT,
  );
  assert.equal(onlyStale.state, "unknown");
});

test("Hi-Fi Cable Output is never counted as CABLE Output", () => {
  assert.equal(classifyMicEndpoint({ name: HIFI, interfaceName: "VB-Audio Hi-Fi Cable" }), "other-virtual");
  assert.equal(classifyMicEndpoint({ name: "Hi-Fi Cable Output" }), "other-virtual");
  assert.equal(classifyMicEndpoint({ name: CABLE, interfaceName: "VB-Audio Virtual Cable" }), "cable");
  assert.equal(classifyMicEndpoint({ name: "CABLE Output" }), "cable");
  // Renamed by the user in Sound settings: the driver's interface name still identifies it.
  assert.equal(classifyMicEndpoint({ name: "Meet mic (VB-Audio Virtual Cable)", interfaceName: "VB-Audio Virtual Cable" }), "cable");
  assert.equal(classifyMicEndpoint({ name: REALTEK, interfaceName: "Realtek(R) Audio" }), "real");

  const state = decideMeetMicState({ endpoints: [endpoint(HIFI, [chromeSession()])] }, CONTEXT);
  assert.notEqual(state.state, "cable");
  assert.equal(state.state, "unknown");
  assert.equal(state.reason, "other-virtual-device");
});

test("the cable together with Hi-Fi Cable is ambiguous, not cable", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(HIFI, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(state.state, "ambiguous");
});

test("WarpTalk's own capture of the real mic is excluded", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(REALTEK, [warptalkSession()])] },
    CONTEXT,
  );
  assert.equal(state.state, "cable");
});

test("with a known browser PID, another browser's sessions do not count", () => {
  const otherBrowser = chromeSession("active", 7100, 7000);
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(REALTEK, [otherBrowser])] },
    CONTEXT,
  );
  assert.equal(state.state, "cable");
});

test("non-browser processes on the mic do not count", () => {
  const zoom = { pid: 3100, state: "active", chain: [{ pid: 3100, name: "Zoom.exe" }] };
  const state = decideMeetMicState({ endpoints: [endpoint(REALTEK, [zoom])] }, { ...CONTEXT, browserPid: null });
  assert.equal(state.state, "unknown");
  assert.equal(state.browserPid, undefined);
});

test("without a browser PID any browser tree counts and a single root is reported", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(CABLE, [chromeSession()])] },
    { browserPid: null, excludePids: [WARPTALK], at: AT },
  );
  assert.equal(state.state, "cable");
  assert.equal(state.browserPid, BROWSER);
});

test("the system sounds session (pid 0) never counts", () => {
  const state = decideMeetMicState(
    { endpoints: [endpoint(REALTEK, [{ pid: 0, state: "active", chain: [] }])] },
    { browserPid: null, excludePids: [], at: AT },
  );
  assert.equal(state.state, "unknown");
});

test("the helper script is pure ASCII and never sets a device", () => {
  assert.equal(/[^\x00-\x7f]/.test(MIC_SESSION_SENSOR_SCRIPT), false);
  for (const forbidden of ["SetDeviceFormat", "SetDefaultEndpoint", "PolicyConfig", "SetMute", "SetMasterVolume"]) {
    assert.equal(MIC_SESSION_SENSOR_SCRIPT.includes(forbidden), false, forbidden);
  }
});

// ---------------------------------------------------------------------------------------------
// The speaker (render endpoints)
// ---------------------------------------------------------------------------------------------

const CABLE_IN = "CABLE Input (VB-Audio Virtual Cable)";
const SPEAKERS = "Speakers (Realtek(R) Audio)";
const HIFI_IN = "Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)";

test("field 2026-10-03: Meet's speaker on CABLE Input reads as speaker cable", () => {
  // Meet's mic on CABLE Output and its speaker on CABLE Input: the far side loops back into Meet's
  // own microphone and the user hears nothing.
  const state = decideMeetMicState(
    {
      endpoints: [endpoint(CABLE, [chromeSession()])],
      render: [endpoint(CABLE_IN, [chromeSession()]), endpoint(SPEAKERS, [])],
    },
    CONTEXT,
  );
  assert.deepEqual(state, {
    at: AT,
    browserPid: BROWSER,
    speaker: "cable",
    speakerEndpoints: [CABLE_IN],
    state: "cable",
    endpoint: CABLE,
    endpoints: [CABLE],
  });
});

test("speaker on real speakers reads as real; on both, cable wins (that is the problem)", () => {
  const real = decideMeetMicState(
    { endpoints: [], render: [endpoint(CABLE_IN, []), endpoint(SPEAKERS, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(real.speaker, "real");
  assert.deepEqual(real.speakerEndpoints, [SPEAKERS]);
  const both = decideMeetMicState(
    { endpoints: [], render: [endpoint(CABLE_IN, [chromeSession()]), endpoint(SPEAKERS, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(both.speaker, "cable");
  assert.deepEqual(both.speakerEndpoints, [CABLE_IN, SPEAKERS]);
});

test("Hi-Fi Cable Input is never counted as CABLE Input", () => {
  assert.equal(classifySpeakerEndpoint({ name: HIFI_IN, interfaceName: "VB-Audio Hi-Fi Cable" }), "other-virtual");
  assert.equal(classifySpeakerEndpoint({ name: "Hi-Fi Cable Input" }), "other-virtual");
  assert.equal(classifySpeakerEndpoint({ name: CABLE_IN, interfaceName: "VB-Audio Virtual Cable" }), "cable");
  assert.equal(classifySpeakerEndpoint({ name: "CABLE Input" }), "cable");
  // Renamed in Sound settings: VB-CABLE's interface name, on a render endpoint, is CABLE Input.
  assert.equal(classifySpeakerEndpoint({ name: "Meet out", interfaceName: "VB-Audio Virtual Cable" }), "cable");
  assert.equal(classifySpeakerEndpoint({ name: SPEAKERS, interfaceName: "Realtek(R) Audio" }), "real");
  // The capture rule is not the render rule: CABLE Output is not a speaker name.
  assert.equal(classifySpeakerEndpoint({ name: "CABLE Output" }), "other-virtual");

  const state = decideMeetMicState({ endpoints: [], render: [endpoint(HIFI_IN, [chromeSession()])] }, CONTEXT);
  assert.equal(state.speaker, "unknown");
  assert.deepEqual(state.speakerEndpoints, [HIFI_IN]);
});

test("WarpTalk playing the dub into CABLE Input is not the browser's speaker", () => {
  const state = decideMeetMicState(
    { endpoints: [], render: [endpoint(CABLE_IN, [warptalkSession()]), endpoint(SPEAKERS, [chromeSession()])] },
    CONTEXT,
  );
  assert.equal(state.speaker, "real");
});

test("speaker: inactive sessions, other browsers and an unreadable render side are not 'cable'", () => {
  const inactive = decideMeetMicState({ endpoints: [], render: [endpoint(CABLE_IN, [chromeSession("inactive")])] }, CONTEXT);
  assert.deepEqual({ speaker: inactive.speaker, listed: inactive.speakerEndpoints }, { speaker: "unknown", listed: undefined });
  const otherBrowser = decideMeetMicState(
    { endpoints: [], render: [endpoint(CABLE_IN, [chromeSession("active", 7100, 7000)])] },
    CONTEXT,
  );
  assert.equal(otherBrowser.speaker, "unknown");
  // The helper could not read the render side: the mic answer stands, the speaker is unknown.
  const unread = decideMeetMicState({ endpoints: [endpoint(CABLE, [chromeSession()])], render: null }, CONTEXT);
  assert.equal(unread.state, "cable");
  assert.equal(unread.speaker, "unknown");
  // An older helper that sends no render list at all: no speaker field, exactly as before.
  const older = decideMeetMicState({ endpoints: [endpoint(CABLE, [chromeSession()])] }, CONTEXT);
  assert.equal("speaker" in older, false);
});

test("a speaker change alone is a change of the payload", () => {
  const a = decideMeetMicState({ endpoints: [endpoint(CABLE, [chromeSession()])], render: [endpoint(SPEAKERS, [chromeSession()])] }, CONTEXT);
  const b = decideMeetMicState({ endpoints: [endpoint(CABLE, [chromeSession()])], render: [endpoint(CABLE_IN, [chromeSession()])] }, CONTEXT);
  assert.equal(sameMeetMicState(a, a), true);
  assert.equal(sameMeetMicState(a, b), false);
});

test("the helper reads render endpoints too, and a failed render read never fails the poll", () => {
  assert.match(MIC_SESSION_SENSOR_SCRIPT, /Poll\(1\)/);
  assert.match(MIC_SESSION_SENSOR_SCRIPT, /try \{ \$render = \[WarpTalkMicSessions\]::Poll\(0\) \} catch \{ \$render = 'null' \}/);
  assert.match(MIC_SESSION_SENSOR_SCRIPT, /EnumAudioEndpoints\(flow, 1, out devices\)/);
  assert.match(MIC_SESSION_SENSOR_SCRIPT, /"render":/);
});

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (callback, ms) => {
      const handle = { callback, ms };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const index = pending.indexOf(handle);
      if (index !== -1) pending.splice(index, 1);
    },
    async fire() {
      const handle = pending.shift();
      await handle.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("the stream polls while running, emits only on change, and stops the helper", async () => {
  const snapshots = [
    { endpoints: [endpoint(REALTEK, [chromeSession()])] },
    { endpoints: [endpoint(REALTEK, [chromeSession()])] },
    { endpoints: [endpoint(CABLE, [chromeSession()]), endpoint(REALTEK, [chromeSession("inactive")])] },
  ];
  let stopped = 0;
  const emitted = [];
  const timers = fakeTimers();
  const stream = new MeetMicStateStream({
    sensor: { poll: async () => snapshots.shift(), stop: () => stopped++ },
    emit: (state) => emitted.push(state.state),
    browserPid: () => BROWSER,
    excludePids: () => [WARPTALK],
    now: () => AT,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, ["real"]);
  assert.equal(timers.pending[0].ms, 2000);
  await timers.fire();
  assert.deepEqual(emitted, ["real"]);
  await timers.fire();
  assert.deepEqual(emitted, ["real", "cable"]);
  assert.equal(stream.current.state, "cable");

  stream.stop();
  assert.equal(stopped, 1);
  assert.equal(timers.pending.length, 0);
  assert.equal(stream.isRunning, false);
});

test("a failed poll reports probe-failed once and backs off", async () => {
  const emitted = [];
  const timers = fakeTimers();
  const stream = new MeetMicStateStream({
    sensor: { poll: async () => { throw new Error("boom"); }, stop: () => undefined },
    emit: (state) => emitted.push(state),
    browserPid: () => null,
    excludePids: () => [],
    now: () => AT,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, [{ state: "unknown", reason: "probe-failed", at: AT }]);
  assert.equal(timers.pending[0].ms, 4000);
  await timers.fire();
  assert.equal(emitted.length, 1);
  assert.equal(timers.pending[0].ms, 8000);
  stream.stop();
});

test("the stream emits when only the speaker changes", async () => {
  const mic = [endpoint(CABLE, [chromeSession()])];
  const snapshots = [
    { endpoints: mic, render: [endpoint(SPEAKERS, [chromeSession()])] },
    { endpoints: mic, render: [endpoint(CABLE_IN, [chromeSession()])] },
  ];
  const emitted = [];
  const timers = fakeTimers();
  const stream = new MeetMicStateStream({
    sensor: { poll: async () => snapshots.shift(), stop: () => undefined },
    emit: (state) => emitted.push(`${state.state}/${state.speaker}`),
    browserPid: () => BROWSER,
    excludePids: () => [WARPTALK],
    now: () => AT,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  await timers.fire();
  assert.deepEqual(emitted, ["cable/real", "cable/cable"]);
  stream.stop();
});

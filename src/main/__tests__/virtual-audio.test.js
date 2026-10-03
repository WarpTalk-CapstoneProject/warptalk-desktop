import test from "node:test";
import assert from "node:assert/strict";

import {
  MAC_BUNDLED_DRIVERS,
  buildMacDriverInstallScript,
  describeMacVirtualAudio,
  describeWindowsVirtualAudioForEndpoints,
  lastGoodEndpointNames,
  toAppleScriptAdminCommand,
  withHiFiCableFormat,
} from "../virtual-audio.ts";

const SUPPORTED_BUILD = 22631;
const UNSUPPORTED_BUILD = 19045;
const CABLE_OUTPUT = "CABLE Output (VB-Audio Virtual Cable)";
const HIFI_OUTPUT = "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)";

test("Windows recommends the free cable when it is installed on a process-loopback build", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
    true,
  );

  assert.equal(status.bridgeMode, "outbound-only");
  assert.equal(status.ready, false);
  assert.equal(status.recommendedProviderId, "vbcable-free");
  assert.equal(status.capabilities?.processLoopback, true);
  assert.equal(status.capabilities?.processLoopbackRuntime, "available");
  assert.equal(status.capabilities?.minWindowsProcessLoopbackBuild, 20348);
  assert.equal(status.capabilities?.outboundOnly, true);
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.providerRole, device.installed]),
    [["vbcable-free", "primary", true]],
  );
});

test("Windows exposes every free-cable loopback risk control in code", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
  );

  assert.deepEqual(
    status.riskControls?.map((risk) => risk.id),
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "B1", "B2", "X1"],
  );
  assert.equal(status.riskControls?.find((risk) => risk.id === "R1")?.status, "mitigated");
  // R6 left the guarded set when the silence padding it named was removed: the padding was itself
  // the defect, pushing every frame after a gap a full gap into the future, and the destination
  // node emits silence for unscheduled intervals without any help.
  assert.equal(status.riskControls?.find((risk) => risk.id === "R6")?.status, "mitigated");
  for (const id of ["R2", "R3", "R4", "R5", "R7", "R8"]) {
    assert.equal(status.riskControls?.find((risk) => risk.id === id)?.status, "guarded");
  }
  assert.equal(status.riskControls?.find((risk) => risk.id === "B1")?.status, "implemented");
  assert.equal(status.riskControls?.find((risk) => risk.id === "X1")?.status, "implemented");
});

test("a new enough Windows does not by itself make the capture path available", () => {
  // The build number says the OS offers process loopback. It says nothing about whether the native
  // addon loaded or a window can be resolved to a PID. Reporting "available" from the build alone
  // put the web tier picker one rung too high, and the meeting went silent in one direction with
  // nothing on screen to explain it.
  const notWired = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
    false,
  );
  const wired = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
    true,
  );

  assert.equal(notWired.capabilities?.processLoopback, true);
  assert.equal(notWired.capabilities?.processLoopbackRuntime, "not-wired");
  assert.equal(wired.capabilities?.processLoopbackRuntime, "available");

  // Omitting the argument has to read as not wired: a caller that cannot answer must cost a rung,
  // never claim one.
  const unanswered = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
  );
  assert.equal(unanswered.capabilities?.processLoopbackRuntime, "not-wired");
});

test("an old Windows stays not-wired even when the runtime is fully wired", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    UNSUPPORTED_BUILD,
    true,
  );

  assert.equal(status.capabilities?.processLoopback, false);
  assert.equal(status.capabilities?.processLoopbackRuntime, "not-wired");
});

test("tab-level contamination is recorded as a limitation, not as an isolation claim", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
  );

  // R1 and R9 are easy to conflate, and conflating them is how a reader concludes that picking a
  // Meet window keeps the rest of that browser out. Measurement says otherwise: two tabs of one
  // browser instance both land in the capture. R1 may stay "mitigated" only while it is scoped to
  // non-browser audio; the tab case has to stay a stated limitation with no guard pretending to
  // cover it.
  const r1 = status.riskControls?.find((risk) => risk.id === "R1");
  const r9 = status.riskControls?.find((risk) => risk.id === "R9");

  assert.equal(r9?.status, "known-limitation");
  assert.match(r9?.control ?? "", /not tab from tab/i);
  assert.match(r1?.control ?? "", /non-Chrome audio/i);
  assert.doesNotMatch(r1?.control ?? "", /\btab\b/i);
});

test("Windows does not mark the free cable primary path usable below process-loopback build", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    UNSUPPORTED_BUILD,
  );

  assert.equal(status.bridgeMode, "caption-only");
  assert.equal(status.recommendedProviderId, "vbcable-free");
  assert.equal(status.capabilities?.processLoopback, false);
  assert.equal(status.capabilities?.processLoopbackRuntime, "not-wired");
  assert.equal(status.capabilities?.outboundOnly, false);
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.providerRole, device.installed]),
    [["vbcable-free", "primary", true]],
  );
});

test("Voicemeeter alone is backup availability, never the recommended provider", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    [
      "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)",
      "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)",
    ],
    UNSUPPORTED_BUILD,
  );

  assert.equal(status.bridgeMode, "installed-not-running");
  assert.equal(status.ready, false);
  assert.equal(status.recommendedProviderId, "vbcable-free");
  assert.equal(status.capabilities?.fullBridge, false);
  assert.equal(status.capabilities?.processLoopback, false);
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.providerRole, device.installed]),
    [
      ["voicemeeter-banana", "backup", true],
      ["voicemeeter-banana", "backup", true],
    ],
  );
});

test("VB-CABLE A+B endpoint names do not become a provider path", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE-A Output (VB-Audio Cable A)", "CABLE-B Input (VB-Audio Cable B)"],
    SUPPORTED_BUILD,
  );

  assert.equal(status.bridgeMode, "caption-only");
  assert.equal(status.ready, false);
  assert.equal(status.recommendedProviderId, "vbcable-free");
  assert.equal(status.capabilities?.fullBridge, false);
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.providerRole, device.installed]),
    [["vbcable-free", "primary", false]],
  );
  assert.deepEqual(status.foreignDrivers, [
    "CABLE-A Output (VB-Audio Cable A)",
    "CABLE-B Input (VB-Audio Cable B)",
  ]);
});

/** What the registry lists for both free cables: each endpoint by friendly name and by bare stem. */
const TWO_FREE_CABLES = [
  "CABLE Input (VB-Audio Virtual Cable)",
  "CABLE Output (VB-Audio Virtual Cable)",
  "CABLE Output",
  "Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)",
  "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)",
  "Hi-Fi Cable Output",
];

test("two free cables make a full Windows bridge that is ready", () => {
  const status = describeWindowsVirtualAudioForEndpoints(TWO_FREE_CABLES, SUPPORTED_BUILD, true);

  assert.equal(status.bridgeMode, "full");
  assert.equal(status.ready, true);
  assert.equal(status.capabilities?.fullBridge, true);
  assert.equal(status.capabilities?.outboundOnly, true);
  // VB-CABLE is still the recommendation: it is the leg without which nothing reaches the meeting.
  assert.equal(status.recommendedProviderId, "vbcable-free");
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.leg, device.installed]),
    [
      ["vbcable-free", "outbound", true],
      ["hifi-cable-free", "inbound", true],
    ],
  );
  // Both endpoints of both cables are ours, including the ones nobody selects.
  assert.deepEqual(status.foreignDrivers, []);
});

test("two free cables need no process loopback, so an old Windows build still gets the full bridge", () => {
  const status = describeWindowsVirtualAudioForEndpoints(TWO_FREE_CABLES, UNSUPPORTED_BUILD);

  assert.equal(status.bridgeMode, "full");
  assert.equal(status.ready, true);
  assert.equal(status.capabilities?.processLoopback, false);
});

test("Hi-Fi Cable alone is not mistaken for VB-CABLE", () => {
  // "cable output" is inside "Hi-Fi Cable Output". Substring matching read this machine as having
  // the outbound cable, and the dub would have been routed to a device that does not exist.
  const status = describeWindowsVirtualAudioForEndpoints(
    ["Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)", "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)", "Hi-Fi Cable Output"],
    SUPPORTED_BUILD,
    true,
  );

  assert.equal(status.ready, false);
  assert.equal(status.bridgeMode, "caption-only");
  assert.deepEqual(
    status.devices.map((device) => [device.providerId, device.installed]),
    [["vbcable-free", false]],
  );
  assert.deepEqual(status.foreignDrivers, []);
});

test("VB-CABLE without Hi-Fi Cable keeps the loopback path exactly as before", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Input (VB-Audio Virtual Cable)", "CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
    true,
  );

  assert.equal(status.bridgeMode, "outbound-only");
  assert.equal(status.ready, false);
  assert.equal(status.capabilities?.processLoopbackRuntime, "available");
  assert.deepEqual(status.foreignDrivers, [], "CABLE Input is VB-CABLE's own endpoint, not a foreign driver");
});

test("two free cables outrank an installed Voicemeeter", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    [
      ...TWO_FREE_CABLES,
      "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)",
      "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)",
    ],
    SUPPORTED_BUILD,
  );

  assert.equal(status.bridgeMode, "full");
  assert.deepEqual(
    status.devices.map((device) => device.providerId),
    ["vbcable-free", "hifi-cable-free"],
  );
});

test("a Mac with WarpTalk's own devices uses them, named WarpTalk", () => {
  const status = describeMacVirtualAudio(["WarpTalkMicrophone.driver", "WarpTalkSpeaker.driver"]);

  assert.equal(status.ready, true);
  assert.equal(status.bridgeMode, "full");
  assert.equal(status.recommendedProviderId, "warptalk-audio");
  assert.deepEqual(
    status.devices.map((device) => [device.leg, device.deviceName, device.installed]),
    [
      ["outbound", "WarpTalk Microphone", true],
      ["inbound", "WarpTalk Speaker", true],
    ],
  );
  assert.deepEqual(status.foreignDrivers, []);
});

test("a Mac set up with BlackHole keeps working, and BlackHole is not reported as foreign", () => {
  const status = describeMacVirtualAudio(["BlackHole2ch.driver", "BlackHole16ch.driver"]);

  assert.equal(status.ready, true);
  assert.deepEqual(
    status.devices.map((device) => device.deviceName),
    ["BlackHole 2ch", "BlackHole 16ch"],
  );
  // Still recommends WarpTalk's own pair: that is what the installer offers.
  assert.equal(status.recommendedProviderId, "warptalk-audio");
  assert.deepEqual(status.foreignDrivers, []);
});

test("a half-finished WarpTalk install does not pull a working BlackHole Mac off BlackHole", () => {
  const status = describeMacVirtualAudio([
    "BlackHole2ch.driver",
    "BlackHole16ch.driver",
    "WarpTalkMicrophone.driver",
  ]);

  assert.equal(status.ready, true);
  assert.deepEqual(
    status.devices.map((device) => device.providerId),
    ["blackhole", "blackhole"],
  );
});

test("a Mac with nothing installed is shown WarpTalk's devices to install", () => {
  const status = describeMacVirtualAudio(["Soundflower.driver"]);

  assert.equal(status.ready, false);
  assert.deepEqual(
    status.devices.map((device) => [device.deviceName, device.installed]),
    [
      ["WarpTalk Microphone", false],
      ["WarpTalk Speaker", false],
    ],
  );
  assert.deepEqual(status.foreignDrivers, ["Soundflower.driver"]);
});

test("the Mac install script copies only the named bundles and restarts coreaudiod", () => {
  const script = buildMacDriverInstallScript("/Applications/WarpTalk.app/Contents/Resources/audio-drivers");

  for (const bundle of MAC_BUNDLED_DRIVERS) {
    assert.match(script, new RegExp(`cp -R '/Applications/WarpTalk.app/Contents/Resources/audio-drivers/${bundle}' '/Library/Audio/Plug-Ins/HAL/${bundle}'`));
    assert.match(script, new RegExp(`rm -rf '/Library/Audio/Plug-Ins/HAL/${bundle}'`));
  }
  assert.match(script, /xattr -dr com\.apple\.quarantine/);
  assert.match(script, /killall coreaudiod/);
  // Never a wildcard removal in the HAL directory, which holds other applications' drivers.
  assert.doesNotMatch(script, /rm -rf '\/Library\/Audio\/Plug-Ins\/HAL'( |;|$)/);
  assert.doesNotMatch(script, /HAL\/\*/);
});

test("the Mac install script refuses a bundle name that could escape the HAL directory", () => {
  assert.throws(() => buildMacDriverInstallScript("/tmp/drivers", ["../../evil.driver"]), /unexpected driver bundle/);
  assert.throws(() => buildMacDriverInstallScript("/tmp/drivers", ["Warp Talk.driver"]), /unexpected driver bundle/);
});

test("a source path with quotes survives both the shell and the AppleScript quoting", () => {
  const script = buildMacDriverInstallScript(`/Volumes/It's "WarpTalk"/Resources`, ["WarpTalkMicrophone.driver"]);
  const command = toAppleScriptAdminCommand(script);

  assert.match(script, /'\/Volumes\/It'\\''s "WarpTalk"\/Resources\/WarpTalkMicrophone\.driver'/);
  assert.ok(command.startsWith('do shell script "'));
  assert.ok(command.endsWith('" with administrator privileges'));
  // Every double quote inside the literal is escaped, so the literal cannot end early.
  const literal = command.slice('do shell script "'.length, -'" with administrator privileges'.length);
  assert.doesNotMatch(literal, /(^|[^\\])"/);
});

test("bridge modes: no cable means text-only possible and voice not possible", () => {
  const status = describeWindowsVirtualAudioForEndpoints([], SUPPORTED_BUILD, true);
  assert.deepEqual(status.bridgeModes, {
    textOnly: { possible: true },
    voice: { possible: false, cableInstalled: false, reason: "cable-missing" },
  });
  // bridgeMode keeps describing voice mode, unchanged.
  assert.equal(status.bridgeMode, "caption-only");
});

test("bridge modes: VB-CABLE with loopback makes voice possible via loopback", () => {
  const status = describeWindowsVirtualAudioForEndpoints([CABLE_OUTPUT], SUPPORTED_BUILD, true);
  assert.deepEqual(status.bridgeModes, {
    textOnly: { possible: true },
    voice: { possible: true, cableInstalled: true, inbound: "process-loopback" },
  });
});

test("bridge modes: two free cables make voice possible even where loopback is not", () => {
  const status = describeWindowsVirtualAudioForEndpoints([CABLE_OUTPUT, HIFI_OUTPUT], UNSUPPORTED_BUILD, false);
  assert.deepEqual(status.bridgeModes, {
    textOnly: { possible: false, reason: "process-loopback-unsupported" },
    voice: { possible: true, cableInstalled: true, inbound: "hifi-cable" },
  });
});

test("bridge modes: an unwired loopback runtime blocks text-only and loopback-voice", () => {
  const status = describeWindowsVirtualAudioForEndpoints([CABLE_OUTPUT], SUPPORTED_BUILD, false);
  assert.deepEqual(status.bridgeModes, {
    textOnly: { possible: false, reason: "loopback-runtime-not-wired" },
    voice: { possible: false, cableInstalled: true, reason: "inbound-unavailable" },
  });
});

test("bridge modes: Hi-Fi Cable alone is not the voice cable", () => {
  const status = describeWindowsVirtualAudioForEndpoints([HIFI_OUTPUT], SUPPORTED_BUILD, true);
  assert.equal(status.bridgeModes?.voice.cableInstalled, false);
  assert.equal(status.bridgeModes?.voice.possible, false);
  assert.equal(status.bridgeModes?.textOnly.possible, true);
});

test("bridge modes on a Mac: no text-only, voice once both devices are in", () => {
  assert.deepEqual(describeMacVirtualAudio(["WarpTalkMicrophone.driver", "WarpTalkSpeaker.driver"]).bridgeModes, {
    textOnly: { possible: false, reason: "process-loopback-unsupported" },
    voice: { possible: true, cableInstalled: true, inbound: "virtual-device" },
  });
  assert.equal(describeMacVirtualAudio([]).bridgeModes?.voice.reason, "cable-missing");
});

// Endpoint labels: the renderer reads these instead of keeping its own device-name tables.

const WINDOWS_LABELS = {
  outboundProviderId: "vbcable-free",
  outboundSink: "CABLE Input (VB-Audio Virtual Cable)",
  meetMicrophone: "CABLE Output (VB-Audio Virtual Cable)",
  inboundProviderId: "hifi-cable-free",
  inboundCapture: "Hi-Fi Cable Output",
  meetSpeaker: "Hi-Fi Cable Input",
  inboundOptional: true,
};

test("endpoint labels: Windows always names VB-CABLE out and Hi-Fi Cable back, whatever is installed", () => {
  for (const endpoints of [[], [CABLE_OUTPUT], [CABLE_OUTPUT, HIFI_OUTPUT], [HIFI_OUTPUT]]) {
    for (const build of [SUPPORTED_BUILD, UNSUPPORTED_BUILD]) {
      assert.deepEqual(
        describeWindowsVirtualAudioForEndpoints(endpoints, build, true).endpointLabels,
        WINDOWS_LABELS,
        `${JSON.stringify(endpoints)} on ${build}`,
      );
    }
  }
});

test("endpoint labels: Voicemeeter is reported as a device but never becomes the route", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)", "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)"],
    UNSUPPORTED_BUILD,
  );
  assert.equal(status.bridgeMode, "installed-not-running");
  assert.deepEqual(status.endpointLabels, WINDOWS_LABELS);
});

test("endpoint labels: the Windows labels agree with the detection table and are substring-safe", () => {
  const status = describeWindowsVirtualAudioForEndpoints([CABLE_OUTPUT, HIFI_OUTPUT], SUPPORTED_BUILD, true);
  const labels = status.endpointLabels;
  assert.ok(labels);
  // Meet's microphone is the outbound device detection keys on; the inbound capture is Hi-Fi's.
  assert.equal(labels.meetMicrophone, status.devices.find((device) => device.leg === "outbound")?.deviceName);
  assert.ok(
    status.devices.find((device) => device.leg === "inbound")?.deviceName.startsWith(labels.inboundCapture ?? "?"),
  );
  // Matched as a substring by the renderer: no label may sit inside another endpoint's full name.
  const fullNames = [
    "CABLE Input (VB-Audio Virtual Cable)",
    "CABLE Output (VB-Audio Virtual Cable)",
    "Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)",
    "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)",
  ];
  for (const label of [labels.outboundSink, labels.meetMicrophone, labels.inboundCapture, labels.meetSpeaker]) {
    const hits = fullNames.filter((name) => name.toLowerCase().includes(String(label).toLowerCase()));
    assert.equal(hits.length, 1, `${label} matches ${JSON.stringify(hits)}`);
  }
});

test("endpoint labels: a Mac names the pair it actually chose, duplex on both legs", () => {
  assert.deepEqual(describeMacVirtualAudio(["WarpTalkMicrophone.driver", "WarpTalkSpeaker.driver"]).endpointLabels, {
    outboundProviderId: "warptalk-audio",
    outboundSink: "WarpTalk Microphone",
    meetMicrophone: "WarpTalk Microphone",
    inboundProviderId: "warptalk-audio",
    inboundCapture: "WarpTalk Speaker",
    meetSpeaker: "WarpTalk Speaker",
    inboundOptional: false,
  });
  const blackHole = describeMacVirtualAudio(["BlackHole2ch.driver", "BlackHole16ch.driver"]).endpointLabels;
  assert.equal(blackHole?.outboundProviderId, "blackhole");
  assert.equal(blackHole?.outboundSink, "BlackHole 2ch");
  assert.equal(blackHole?.inboundCapture, "BlackHole 16ch");
  // Nothing installed: the pair the installer offers.
  assert.equal(describeMacVirtualAudio([]).endpointLabels?.outboundSink, "WarpTalk Microphone");
});

test("endpoint labels survive the Hi-Fi format read", async () => {
  const status = describeWindowsVirtualAudioForEndpoints([CABLE_OUTPUT, HIFI_OUTPUT], SUPPORTED_BUILD, true);
  const withFormats = await withHiFiCableFormat(status, async () => ({
    input: { sampleRate: 48000, bitsPerSample: 24, channels: 2 },
    output: { sampleRate: 48000, bitsPerSample: 24, channels: 2 },
  }));
  assert.deepEqual(withFormats.endpointLabels, WINDOWS_LABELS);
  assert.equal(withFormats.hifiFormatMismatch, false);
});

test("an endpoint read that failed keeps the last list: a timeout is not 'VB-CABLE is missing' (23:06Z)", () => {
  const answers = [[CABLE_OUTPUT, HIFI_OUTPUT], null, [], null];
  const failed = [];
  const names = lastGoodEndpointNames(() => answers.shift(), (kept) => failed.push(kept));
  const installed = () =>
    describeWindowsVirtualAudioForEndpoints(names(), SUPPORTED_BUILD, true).devices.some(
      (device) => device.providerId === "vbcable-free" && device.installed,
    );

  assert.equal(installed(), true);
  // PowerShell ran out of its 2.5 s: the loopback gate used to answer B2 driver-missing here.
  assert.equal(installed(), true);
  assert.deepEqual(failed, [2]);
  // A read that worked and found nothing is an answer, and replaces what was remembered.
  assert.equal(installed(), false);
  assert.equal(installed(), false);
  assert.deepEqual(failed, [2, 0]);
});

test("with no earlier read to go by, a failed endpoint read stays empty (fails closed)", () => {
  const names = lastGoodEndpointNames(() => null);
  assert.deepEqual(names(), []);
});

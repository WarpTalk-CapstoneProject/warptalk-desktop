import test from "node:test";
import assert from "node:assert/strict";

import { describeWindowsVirtualAudioForEndpoints } from "../virtual-audio.ts";

const SUPPORTED_BUILD = 22631;
const UNSUPPORTED_BUILD = 19045;

test("Windows recommends the free cable when it is installed on a process-loopback build", () => {
  const status = describeWindowsVirtualAudioForEndpoints(
    ["CABLE Output (VB-Audio Virtual Cable)"],
    SUPPORTED_BUILD,
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
  for (const id of ["R2", "R3", "R4", "R5", "R6", "R7", "R8"]) {
    assert.equal(status.riskControls?.find((risk) => risk.id === id)?.status, "guarded");
  }
  assert.equal(status.riskControls?.find((risk) => risk.id === "B1")?.status, "implemented");
  assert.equal(status.riskControls?.find((risk) => risk.id === "X1")?.status, "implemented");
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

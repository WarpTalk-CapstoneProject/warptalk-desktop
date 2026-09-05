import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWindowsLoopbackStart } from "../windows-loopback-runtime.ts";

function readyStatus(overrides = {}) {
  return {
    platform: "win32",
    supported: true,
    ready: false,
    bridgeMode: "outbound-only",
    recommendedProviderId: "vbcable-free",
    devices: [
      {
        leg: "outbound",
        driverBundle: "VB-CABLE",
        deviceName: "CABLE Output (VB-Audio Virtual Cable)",
        installed: true,
        providerId: "vbcable-free",
        providerName: "VB-CABLE",
        providerRole: "primary",
      },
    ],
    capabilities: {
      fullBridge: false,
      outboundOnly: true,
      captionOnly: true,
      processLoopback: true,
      processLoopbackRuntime: "not-wired",
      minWindowsProcessLoopbackBuild: 20348,
    },
    riskControls: [],
    foreignDrivers: [],
    ...overrides,
  };
}

function readyAdapter(overrides = {}) {
  return {
    electronLoopbackApiReady: true,
    pcmToTrackBridgeReady: true,
    silencePaddingReady: true,
    targetProcessResolverReady: true,
    start: async () => undefined,
    stop: async () => undefined,
    ...overrides,
  };
}

const READY_REQUEST = {
  consentGranted: true,
  includeTargetProcessTree: true,
  targetProcessId: 4242,
};

test("Windows loopback start rejects unsupported platforms", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus({ platform: "darwin" }),
    readyAdapter(),
    READY_REQUEST,
  );

  assert.deepEqual(result, { started: false, riskId: "X1", reason: "unsupported-platform" });
});

test("Windows loopback start rejects missing VB-CABLE free driver", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus({ devices: [] }),
    readyAdapter(),
    READY_REQUEST,
  );

  assert.deepEqual(result, { started: false, riskId: "B2", reason: "driver-missing" });
});

test("Windows loopback start rejects Windows builds without process loopback", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus({ capabilities: { ...readyStatus().capabilities, processLoopback: false } }),
    readyAdapter(),
    READY_REQUEST,
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "B2",
    reason: "process-loopback-unsupported",
  });
});

test("Windows loopback start requires explicit scoped consent", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter(),
    { ...READY_REQUEST, consentGranted: false },
  );

  assert.deepEqual(result, { started: false, riskId: "R5", reason: "consent-required" });
});

test("Windows loopback start requires a positive target process id", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter(),
    { ...READY_REQUEST, targetProcessId: 0 },
  );

  assert.deepEqual(result, { started: false, riskId: "R8", reason: "target-process-required" });
});

test("Windows loopback start requires include target process tree", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter(),
    { ...READY_REQUEST, includeTargetProcessTree: false },
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "R7",
    reason: "include-target-tree-required",
  });
});

test("Windows loopback start rejects missing Electron loopback adapter", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter({ electronLoopbackApiReady: false }),
    READY_REQUEST,
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "R2",
    reason: "electron-loopback-api-not-ready",
  });
});

test("Windows loopback start rejects missing target process resolver", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter({ targetProcessResolverReady: false }),
    READY_REQUEST,
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "R8",
    reason: "target-process-resolver-not-ready",
  });
});

test("Windows loopback start rejects missing PCM-to-track bridge", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter({ pcmToTrackBridgeReady: false }),
    READY_REQUEST,
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "R3",
    reason: "pcm-to-track-bridge-not-ready",
  });
});

test("Windows loopback start rejects missing silence padding", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter({ silencePaddingReady: false }),
    READY_REQUEST,
  );

  assert.deepEqual(result, {
    started: false,
    riskId: "R6",
    reason: "silence-padding-not-ready",
  });
});

test("Windows loopback start succeeds only after every risk gate is satisfied", () => {
  const result = evaluateWindowsLoopbackStart(readyStatus(), readyAdapter(), READY_REQUEST);

  assert.deepEqual(result, { started: true });
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  createNativeWindowsLoopbackAdapter,
  evaluateWindowsLoopbackStart,
  WindowsLoopbackRuntime,
} from "../windows-loopback-runtime.ts";

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

test("Windows loopback start rejects a selected source when the resolver is not wired", () => {
  const result = evaluateWindowsLoopbackStart(
    readyStatus(),
    readyAdapter({ targetProcessResolverReady: false }),
    { ...READY_REQUEST, targetProcessId: undefined, sourceId: "window:123456:0" },
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

test("Windows loopback runtime resolves a selected source before starting capture", async () => {
  let startedWith = null;
  const runtime = new WindowsLoopbackRuntime(
    readyAdapter({
      resolveTargetProcessId: async (sourceId) => (sourceId === "window:123456:0" ? 4242 : null),
      start: async (request) => {
        startedWith = request;
      },
    }),
    () => readyStatus(),
  );

  const result = await runtime.start({
    sourceId: "window:123456:0",
    consentGranted: true,
    includeTargetProcessTree: true,
  });

  assert.deepEqual(result, { started: true });
  assert.deepEqual(startedWith, {
    sourceId: "window:123456:0",
    consentGranted: true,
    includeTargetProcessTree: true,
    targetProcessId: 4242,
  });
});

test("Windows loopback runtime fails closed when a selected source cannot resolve to a process", async () => {
  const runtime = new WindowsLoopbackRuntime(
    readyAdapter({
      resolveTargetProcessId: async () => null,
    }),
    () => readyStatus(),
  );

  const result = await runtime.start({
    sourceId: "window:123456:0",
    consentGranted: true,
    includeTargetProcessTree: true,
  });

  assert.deepEqual(result, { started: false, riskId: "R8", reason: "target-source-unresolved" });
});

test("native Windows loopback adapter starts process capture and publishes PCM chunks", async () => {
  let startCall = null;
  let stopCalls = 0;
  const published = [];
  let onData = null;
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: (chunk) => published.push(chunk),
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => ({
      default: {
        LoopbackCapture: class {
          start(targetProcessId, includeProcessTree, callback) {
            startCall = { targetProcessId, includeProcessTree };
            onData = callback;
          }

          stop() {
            stopCalls += 1;
          }
        },
      },
    }),
  });

  await adapter.start({
    sourceId: "window:123456:0",
    targetProcessId: 4242,
    includeTargetProcessTree: true,
    consentGranted: true,
  });
  onData(Buffer.from([1, 0, 255, 255]));
  await adapter.stop();

  assert.deepEqual(startCall, { targetProcessId: 4242, includeProcessTree: true });
  assert.equal(stopCalls, 1);
  assert.equal(published.length, 1);
  assert.deepEqual([...published[0].data], [1, 0, 255, 255]);
  assert.equal(published[0].format, "s16le");
  assert.equal(published[0].sampleRate, 48000);
  assert.equal(published[0].channelCount, 2);
});

/**
 * The refusal now comes from the GATE, not from the start attempt.
 *
 * It used to come from the attempt: the adapter claimed to be ready, `start` was allowed through,
 * the import threw, and the catch turned that into `native-loopback-adapter-unavailable`. The
 * capture was refused either way, so the behaviour looked correct — but `isReady()` was true the
 * whole time, and that is what the virtual-audio status publishes and the web tier picker reads.
 * The machine was offered a rung it could not run.
 */
test("a native adapter that cannot load its addon is not ready, and says so at the gate", async () => {
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => {
      throw new Error("missing native module");
    },
  });
  const runtime = new WindowsLoopbackRuntime(adapter, () => readyStatus());

  const result = await runtime.start(READY_REQUEST);

  assert.deepEqual(result, {
    started: false,
    riskId: "R2",
    reason: "electron-loopback-api-not-ready",
  });

  await runtime.whenProbed();
  assert.equal(adapter.electronLoopbackApiReady, false);
  assert.equal(runtime.isReady(), false, "readiness must reflect the failed import, not the platform");
});

test("a native adapter whose addon loads reports itself ready", async () => {
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => ({ LoopbackCapture: class {} }),
  });
  const runtime = new WindowsLoopbackRuntime(adapter, () => readyStatus());

  await runtime.whenProbed();

  assert.equal(adapter.electronLoopbackApiReady, true);
  assert.equal(runtime.isReady(), true);
});

/**
 * A module that resolves but carries no constructor is the shape a half-broken build produces, and
 * it is the one an `await import(...)` alone cannot tell from a working one.
 */
test("a module without LoopbackCapture is not a wired runtime", async () => {
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => ({}),
  });

  await adapter.whenProbed;

  assert.equal(adapter.electronLoopbackApiReady, false);
});

/**
 * The probe is asynchronous and `start` may be called before it settles. Awaiting it inside
 * `start` is what stops a capture in the first moments after launch from being refused for a
 * readiness that was merely not yet known — so this deliberately does NOT await the probe first.
 */
test("a capture started before the probe settles is not refused for it", async () => {
  let released;
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: () =>
      new Promise((resolve) => {
        released = () => resolve({ LoopbackCapture: class { start() {} stop() {} } });
      }),
  });
  const runtime = new WindowsLoopbackRuntime(adapter, () => readyStatus());

  assert.equal(adapter.electronLoopbackApiReady, false, "false until the probe answers");

  const pending = runtime.start(READY_REQUEST);
  released();

  assert.deepEqual(await pending, { started: true });
});

/** The old failure mode still has to be reachable: an addon that loads and then throws on use. */
test("Windows loopback runtime returns R2 when starting the loaded addon throws", async () => {
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "win32",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => ({
      LoopbackCapture: class {
        start() {
          throw new Error("the device is held by another process");
        }

        stop() {}
      },
    }),
  });
  const runtime = new WindowsLoopbackRuntime(adapter, () => readyStatus());

  const result = await runtime.start(READY_REQUEST);

  assert.deepEqual(result, {
    started: false,
    riskId: "R2",
    reason: "native-loopback-adapter-unavailable",
  });
});

/** Off Windows nothing is imported at all, and readiness is false without a probe having run. */
test("a non-Windows native adapter never attempts the import", async () => {
  let imports = 0;
  const adapter = createNativeWindowsLoopbackAdapter({
    platform: "darwin",
    publishPcmChunk: () => undefined,
    resolveTargetProcessId: async () => 4242,
    importLoopbackCapture: async () => {
      imports += 1;
      return { LoopbackCapture: class {} };
    },
  });

  await adapter.whenProbed;

  assert.equal(imports, 0);
  assert.equal(adapter.electronLoopbackApiReady, false);
});

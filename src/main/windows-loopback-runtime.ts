import { detectVirtualAudio, type VirtualAudioStatus } from "./virtual-audio.ts";
import type {
  WindowsLoopbackCaptureRequest,
  WindowsLoopbackPcmChunk,
  WindowsLoopbackStartResult,
} from "../shared/types.ts";

export type WindowsLoopbackResolvedCaptureRequest =
  Required<Pick<WindowsLoopbackCaptureRequest, "consentGranted" | "includeTargetProcessTree" | "targetProcessId">> &
    Pick<WindowsLoopbackCaptureRequest, "sourceId">;

export interface WindowsLoopbackRuntimeAdapter {
  /** True only when Electron/native capture can avoid chromeMediaSource:'desktop'. */
  electronLoopbackApiReady: boolean;
  /** True only when native PCM can become a publishable MediaStreamTrack. */
  pcmToTrackBridgeReady: boolean;
  /** True only when no-packet gaps are padded with silence before STT publication. */
  silencePaddingReady: boolean;
  /**
   * True once a desktop source id can be turned into the PID the loopback API needs.
   *
   * That is a single step, not the walk this comment used to describe: measured on Chrome 37
   * processes deep, `GetWindowThreadProcessId` on a top-level browser window returns the browser
   * process itself, because Chromium creates its windows there rather than in a renderer. No
   * parent chain has to be climbed. Kept as a flag anyway — a browser that does hand its window
   * to a child process would need one, and the gate should fail closed rather than capture the
   * wrong tree.
   */
  targetProcessResolverReady: boolean;
  resolveTargetProcessId?: (sourceId: string) => Promise<number | null>;
  start: (request: WindowsLoopbackResolvedCaptureRequest) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Whether every leg of the capture path is actually in place.
 *
 * Split out because `capabilities.processLoopbackRuntime` used to be derived from the Windows build
 * number alone — a machine new enough for the API reported "available" even when nothing could
 * capture. The web tier picker reads that field to choose the loopback rung, so the lie put it one
 * rung too high and the meeting went silent in one direction with nothing to explain why.
 */
export function isLoopbackAdapterReady(adapter: WindowsLoopbackRuntimeAdapter): boolean {
  return (
    adapter.electronLoopbackApiReady &&
    adapter.pcmToTrackBridgeReady &&
    adapter.silencePaddingReady &&
    adapter.targetProcessResolverReady
  );
}

export interface LoopbackCaptureNativeModule {
  default?: {
    LoopbackCapture: new () => LoopbackCaptureNativeSession;
  };
  LoopbackCapture?: new () => LoopbackCaptureNativeSession;
}

export interface LoopbackCaptureNativeSession {
  start: (
    targetProcessId: number,
    includeProcessTree: boolean,
    callback: (chunk: Buffer) => void,
  ) => void;
  stop: () => void;
}

export interface NativeWindowsLoopbackAdapterOptions {
  publishPcmChunk: (chunk: WindowsLoopbackPcmChunk) => void;
  resolveTargetProcessId: (sourceId: string) => Promise<number | null>;
  importLoopbackCapture?: () => Promise<LoopbackCaptureNativeModule>;
  platform?: NodeJS.Platform;
}

type WindowsLoopbackStop = Exclude<WindowsLoopbackStartResult, { started: true }>;

const MISSING_RUNTIME_ADAPTER: WindowsLoopbackRuntimeAdapter = {
  electronLoopbackApiReady: false,
  pcmToTrackBridgeReady: false,
  silencePaddingReady: false,
  targetProcessResolverReady: false,
  start: async () => {
    throw new Error("Windows loopback runtime adapter is not wired.");
  },
  stop: async () => undefined,
};

export function createNativeWindowsLoopbackAdapter(
  options: NativeWindowsLoopbackAdapterOptions,
): WindowsLoopbackRuntimeAdapter {
  let activeCapture: LoopbackCaptureNativeSession | null = null;
  const importLoopbackCapture =
    options.importLoopbackCapture ??
    (() => import("loopback-capture") as Promise<LoopbackCaptureNativeModule>);
  const platform = options.platform ?? process.platform;

  return {
    electronLoopbackApiReady: platform === "win32",
    pcmToTrackBridgeReady: true,
    silencePaddingReady: true,
    targetProcessResolverReady: true,
    resolveTargetProcessId: options.resolveTargetProcessId,
    start: async (request) => {
      activeCapture?.stop();

      const loopback = await importLoopbackCapture();
      const Capture = loopback.default?.LoopbackCapture ?? loopback.LoopbackCapture;
      if (!Capture) throw new Error("loopback-capture did not expose LoopbackCapture.");

      const capture = new Capture();
      capture.start(request.targetProcessId, request.includeTargetProcessTree, (buffer) => {
        const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        options.publishPcmChunk({
          data: new Uint8Array(data),
          format: "s16le",
          sampleRate: 48000,
          channelCount: 2,
          capturedAtMs: Date.now(),
        });
      });
      activeCapture = capture;
    },
    stop: async () => {
      activeCapture?.stop();
      activeCapture = null;
    },
  };
}

function missing(
  riskId: WindowsLoopbackStop["riskId"],
  reason: WindowsLoopbackStop["reason"],
): WindowsLoopbackStartResult {
  return { started: false, riskId, reason };
}

export function evaluateWindowsLoopbackStart(
  status: VirtualAudioStatus,
  adapter: WindowsLoopbackRuntimeAdapter,
  request: WindowsLoopbackCaptureRequest,
): WindowsLoopbackStartResult {
  if (status.platform !== "win32") return missing("X1", "unsupported-platform");
  if (!status.devices.some((device) => device.providerId === "vbcable-free" && device.installed)) {
    return missing("B2", "driver-missing");
  }
  if (!status.capabilities?.processLoopback) {
    return missing("B2", "process-loopback-unsupported");
  }
  if (!request.consentGranted) return missing("R5", "consent-required");
  if (request.sourceId && !adapter.targetProcessResolverReady) {
    return missing("R8", "target-process-resolver-not-ready");
  }
  if (!Number.isInteger(request.targetProcessId) || (request.targetProcessId ?? 0) <= 0) {
    return missing("R8", "target-process-required");
  }
  if (request.includeTargetProcessTree !== true) {
    return missing("R7", "include-target-tree-required");
  }
  if (!adapter.electronLoopbackApiReady) {
    return missing("R2", "electron-loopback-api-not-ready");
  }
  if (!adapter.targetProcessResolverReady) {
    return missing("R8", "target-process-resolver-not-ready");
  }
  if (!adapter.pcmToTrackBridgeReady) {
    return missing("R3", "pcm-to-track-bridge-not-ready");
  }
  if (!adapter.silencePaddingReady) {
    return missing("R6", "silence-padding-not-ready");
  }
  return { started: true };
}

export class WindowsLoopbackRuntime {
  private adapter: WindowsLoopbackRuntimeAdapter;
  private statusProvider: () => VirtualAudioStatus;

  constructor(
    adapter: WindowsLoopbackRuntimeAdapter = MISSING_RUNTIME_ADAPTER,
    statusProvider: () => VirtualAudioStatus = detectVirtualAudio,
  ) {
    this.adapter = adapter;
    this.statusProvider = statusProvider;
  }

  async start(request: WindowsLoopbackCaptureRequest = {}): Promise<WindowsLoopbackStartResult> {
    const status = this.statusProvider();
    const resolvedRequest = { ...request };

    if (
      !Number.isInteger(resolvedRequest.targetProcessId) &&
      resolvedRequest.sourceId &&
      this.adapter.targetProcessResolverReady
    ) {
      resolvedRequest.targetProcessId =
        (await this.adapter.resolveTargetProcessId?.(resolvedRequest.sourceId)) ?? undefined;
      if (!resolvedRequest.targetProcessId) {
        return missing("R8", "target-source-unresolved");
      }
    }

    const decision = evaluateWindowsLoopbackStart(status, this.adapter, resolvedRequest);
    if (!decision.started) return decision;

    try {
      await this.adapter.start({
        consentGranted: true,
        includeTargetProcessTree: true,
        sourceId: resolvedRequest.sourceId,
        targetProcessId: resolvedRequest.targetProcessId!,
      });
    } catch {
      return missing("R2", "native-loopback-adapter-unavailable");
    }
    return { started: true };
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  /** Whether this runtime could actually capture right now, for callers building a status. */
  isReady(): boolean {
    return isLoopbackAdapterReady(this.adapter);
  }
}

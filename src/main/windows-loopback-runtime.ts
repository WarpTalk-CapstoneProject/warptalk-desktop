import { detectVirtualAudio, type VirtualAudioStatus } from "./virtual-audio.ts";
import type {
  WindowsLoopbackCaptureRequest,
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
  /** True only after window handle -> renderer PID -> root browser PID has been implemented. */
  targetProcessResolverReady: boolean;
  resolveTargetProcessId?: (sourceId: string) => Promise<number | null>;
  start: (request: WindowsLoopbackResolvedCaptureRequest) => Promise<void>;
  stop: () => Promise<void>;
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

    await this.adapter.start({
      consentGranted: true,
      includeTargetProcessTree: true,
      sourceId: resolvedRequest.sourceId,
      targetProcessId: resolvedRequest.targetProcessId!,
    });
    return { started: true };
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }
}

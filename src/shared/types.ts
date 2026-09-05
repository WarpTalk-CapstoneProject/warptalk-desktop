/**
 * WarpTalk Desktop — Shared Type Definitions
 */

/** Preload API exposed to renderer via contextBridge */
export interface WarpTalkAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => string;
  getRuntimeCapability: () => Promise<DesktopRuntimeCapability>;
  listWindowsLoopbackSources: () => Promise<WindowsLoopbackSource[]>;
  startAudioCapture: (request?: WindowsLoopbackCaptureRequest) => Promise<WindowsLoopbackStartResult>;
  stopAudioCapture: () => Promise<void>;
  joinTranslationRoom: (translationRoomId: string) => Promise<void>;
  leaveTranslationRoom: () => Promise<void>;
  onTranscript: (callback: (data: TranscriptUpdate) => void) => void;
  onTranslation: (callback: (data: TranslationUpdate) => void) => void;
  onConnectionStatus: (callback: (status: ConnectionStatus) => void) => void;
  openExternal: (url: string) => Promise<void>;
  getVirtualAudioStatus: () => Promise<VirtualAudioStatus>;
  installVirtualAudio: () => Promise<VirtualAudioInstallResult>;
  openTranscriptWindow: (roomId: string) => Promise<void>;
  closeTranscriptWindow: () => Promise<void>;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

/**
 * An EXTERNAL_BRIDGE meeting runs on two directional legs. macOS carries them on two BlackHole
 * devices; Windows primary carries outbound on the free VB-CABLE device and inbound through
 * per-process loopback.
 */
export interface VirtualAudioDevice {
  leg: "outbound" | "inbound";
  driverBundle: string;
  /** What to look for in Google Meet's device picker. */
  deviceName: string;
  installed: boolean;
  providerId?: string;
  providerName?: string;
  providerRole?: "primary" | "backup";
}

export interface VirtualAudioStatus {
  platform: string;
  /** False where detection is not implemented, so an empty list is never mistaken for "nothing installed". */
  supported: boolean;
  devices: VirtualAudioDevice[];
  ready: boolean;
  bridgeMode?: "full" | "outbound-only" | "installed-not-running" | "caption-only";
  recommendedProviderId?: string;
  capabilities?: {
    fullBridge: boolean;
    outboundOnly: boolean;
    captionOnly: boolean;
    processLoopback: boolean;
    processLoopbackRuntime?: "available" | "not-wired";
    minWindowsProcessLoopbackBuild?: number;
  };
  riskControls?: VirtualAudioRiskControl[];
  /** Virtual drivers belonging to other applications, surfaced for support rather than used. */
  foreignDrivers: string[];
}

export interface VirtualAudioRiskControl {
  id: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "B1" | "B2" | "X1";
  status: "mitigated" | "guarded" | "implemented" | "known-limitation" | "requires-runtime";
  control: string;
}

export interface VirtualAudioInstallResult {
  started: boolean;
  reason?: string;
}

export interface WindowsLoopbackCaptureRequest {
  /** DesktopCapturer window source chosen by the user; resolved to the owner process in main. */
  sourceId?: string;
  /** The root browser process that owns the selected Google Meet window. */
  targetProcessId?: number;
  /** Must be true: false means EXCLUDE_TARGET_PROCESS_TREE and captures the wrong side. */
  includeTargetProcessTree?: boolean;
  /** Set only after the user picked the meeting window and accepted scoped audio capture. */
  consentGranted?: boolean;
}

export type WindowsLoopbackStartResult =
  | { started: true }
  | {
      started: false;
      riskId: "R2" | "R3" | "R5" | "R6" | "R7" | "R8" | "B2" | "X1";
      reason:
        | "unsupported-platform"
        | "driver-missing"
        | "process-loopback-unsupported"
        | "consent-required"
        | "target-process-required"
        | "target-source-unresolved"
        | "include-target-tree-required"
        | "electron-loopback-api-not-ready"
        | "pcm-to-track-bridge-not-ready"
        | "silence-padding-not-ready"
        | "target-process-resolver-not-ready";
    };

export interface WindowsLoopbackSource {
  id: string;
  name: string;
  windowHandle?: number;
  ownerProcessId?: number;
  likelyMeetingWindow: boolean;
}

export interface DesktopRuntimeCapability {
  deviceIdHash: string;
  os: string;
  ramTotalMb: number;
  ramAvailableMb: number;
  cpuCores: number;
  gpuType: string;
  supportsLocalPiper: boolean;
  supportsLocalClone: boolean;
  audioDriverReady: boolean;
  virtualMicReady: boolean;
  lastProbeLatencyMs: number;
}

export interface AudioChunkMetadata {
  sourceRuntime: "web" | "desktop";
  vadConfidence: number;
  speechStartMs: number;
  speechEndMs: number;
  inputLufs: number;
  noiseSuppressionEnabled: boolean;
}

export interface TranslatedAudioMetadata {
  voiceType: "default" | "blended" | "cloned";
  voiceMode?: "standard" | "blended" | "cloned" | "caption_only";
  cloneStrength?: number;
  anchorProvider?: string;
  cloneProvider?: string;
  renderLocation?: "server" | "desktop";
  cacheKey?: string;
  cacheHit?: boolean;
  synthesisLatencyMs?: number;
  conversionLatencyMs?: number;
  fallbackReason?: string;
}

export interface TranscriptUpdate {
  translationRoomId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  language: string;
  timestamp: number;
  isFinal: boolean;
}

export interface TranslationUpdate {
  translationRoomId: string;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  timestamp: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

declare global {
  interface Window {
    warptalk: WarpTalkAPI;
  }
}

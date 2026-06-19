/**
 * WarpTalk Desktop — Shared Type Definitions
 */

/** Preload API exposed to renderer via contextBridge */
export interface WarpTalkAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => string;
  getRuntimeCapability: () => Promise<DesktopRuntimeCapability>;
  startAudioCapture: () => Promise<void>;
  stopAudioCapture: () => Promise<void>;
  joinTranslationRoom: (translationRoomId: string) => Promise<void>;
  leaveTranslationRoom: () => Promise<void>;
  onTranscript: (callback: (data: TranscriptUpdate) => void) => void;
  onTranslation: (callback: (data: TranslationUpdate) => void) => void;
  onConnectionStatus: (callback: (status: ConnectionStatus) => void) => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
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

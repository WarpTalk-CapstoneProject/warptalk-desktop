/**
 * WarpTalk Desktop — Shared Type Definitions
 */

/** Preload API exposed to renderer via contextBridge */
export interface WarpTalkAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => string;
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

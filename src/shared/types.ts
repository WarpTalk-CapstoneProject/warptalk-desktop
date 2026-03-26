/**
 * WarpTalk Desktop — Shared Type Definitions
 */

/** Preload API exposed to renderer via contextBridge */
export interface WarpTalkAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => string;
  startAudioCapture: () => Promise<void>;
  stopAudioCapture: () => Promise<void>;
  joinMeeting: (meetingId: string) => Promise<void>;
  leaveMeeting: () => Promise<void>;
  onTranscript: (callback: (data: TranscriptUpdate) => void) => void;
  onTranslation: (callback: (data: TranslationUpdate) => void) => void;
  onConnectionStatus: (callback: (status: ConnectionStatus) => void) => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

export interface TranscriptUpdate {
  meetingId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  language: string;
  timestamp: number;
  isFinal: boolean;
}

export interface TranslationUpdate {
  meetingId: string;
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

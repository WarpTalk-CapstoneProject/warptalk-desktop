/**
 * WarpTalk Desktop — Preload Script (Security Bridge)
 *
 * Exposes a safe API from main process to renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("warptalk", {
  // ── App Info ─────────────────────────────────────────────────────
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getPlatform: (): string => process.platform,

  // ── Audio ────────────────────────────────────────────────────────
  startAudioCapture: (): Promise<void> =>
    ipcRenderer.invoke("audio:start-capture"),
  stopAudioCapture: (): Promise<void> =>
    ipcRenderer.invoke("audio:stop-capture"),

  // ── Meeting ──────────────────────────────────────────────────────
  joinMeeting: (meetingId: string): Promise<void> =>
    ipcRenderer.invoke("meeting:join", meetingId),
  leaveMeeting: (): Promise<void> => ipcRenderer.invoke("meeting:leave"),

  // ── Events (main → renderer) ─────────────────────────────────────
  onTranscript: (callback: (data: unknown) => void): void => {
    ipcRenderer.on("transcript:update", (_event, data) => callback(data));
  },
  onTranslation: (callback: (data: unknown) => void): void => {
    ipcRenderer.on("translation:update", (_event, data) => callback(data));
  },
  onConnectionStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on("connection:status", (_event, status) => callback(status));
  },

  // ── Window Control ───────────────────────────────────────────────
  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
});

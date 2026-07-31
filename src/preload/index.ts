/**
 * WarpTalk Desktop - Preload Script (Security Bridge)
 *
 * Exposes a safe API from main process to renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { DesktopRuntimeCapability } from "../shared/types";

contextBridge.exposeInMainWorld("warptalk", {
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getPlatform: (): string => process.platform,
  getRuntimeCapability: (): Promise<DesktopRuntimeCapability> =>
    ipcRenderer.invoke("runtime:capability"),

  startAudioCapture: (): Promise<void> =>
    ipcRenderer.invoke("audio:start-capture"),
  stopAudioCapture: (): Promise<void> =>
    ipcRenderer.invoke("audio:stop-capture"),

  joinTranslationRoom: (translationRoomId: string): Promise<void> =>
    ipcRenderer.invoke("translationRoom:join", translationRoomId),
  leaveTranslationRoom: (): Promise<void> =>
    ipcRenderer.invoke("translationRoom:leave"),

  onTranscript: (callback: (data: unknown) => void): void => {
    ipcRenderer.on("transcript:update", (_event, data) => callback(data));
  },
  onTranslation: (callback: (data: unknown) => void): void => {
    ipcRenderer.on("translation:update", (_event, data) => callback(data));
  },
  onConnectionStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on("connection:status", (_event, status) => callback(status));
  },

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("app:open-external", url),

  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
});

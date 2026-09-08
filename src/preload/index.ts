/**
 * WarpTalk Desktop - Preload Script (Security Bridge)
 *
 * Exposes a safe API from main process to renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopRuntimeCapability,
  MeetPresence,
  WindowsLoopbackPcmChunk,
  VirtualAudioInstallResult,
  VirtualAudioStatus,
} from "../shared/types";

contextBridge.exposeInMainWorld("warptalk", {
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  getPlatform: (): string => process.platform,
  getRuntimeCapability: (): Promise<DesktopRuntimeCapability> =>
    ipcRenderer.invoke("runtime:capability"),
  listWindowsLoopbackSources: () =>
    ipcRenderer.invoke("audio:list-loopback-sources"),

  startAudioCapture: (request?: unknown) =>
    ipcRenderer.invoke("audio:start-capture", request),
  stopAudioCapture: (): Promise<void> =>
    ipcRenderer.invoke("audio:stop-capture"),
  onWindowsLoopbackPcmChunk: (callback: (chunk: WindowsLoopbackPcmChunk) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: WindowsLoopbackPcmChunk) => callback(chunk);
    ipcRenderer.on("audio:loopback-pcm-chunk", listener);
    return () => ipcRenderer.off("audio:loopback-pcm-chunk", listener);
  },

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

  getVirtualAudioStatus: (): Promise<VirtualAudioStatus> =>
    ipcRenderer.invoke("bridge:virtual-audio-status"),
  installVirtualAudio: (): Promise<VirtualAudioInstallResult> =>
    ipcRenderer.invoke("bridge:install-virtual-audio"),
  openTranscriptWindow: (roomId: string | null): Promise<void> =>
    ipcRenderer.invoke("bridge:open-transcript-window", roomId),
  activateRoom: (roomId: string): Promise<void> =>
    ipcRenderer.invoke("bridge:activate-room", roomId),
  onRoomActivated: (callback: (roomId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, roomId: string) => callback(roomId);
    ipcRenderer.on("bridge:room-activated", listener);
    return () => ipcRenderer.off("bridge:room-activated", listener);
  },
  closeTranscriptWindow: (): Promise<void> =>
    ipcRenderer.invoke("bridge:close-transcript-window"),
  watchMeetPresence: (): Promise<void> =>
    ipcRenderer.invoke("bridge:watch-meet-presence"),
  unwatchMeetPresence: (): Promise<void> =>
    ipcRenderer.invoke("bridge:unwatch-meet-presence"),
  onMeetPresence: (callback: (presence: MeetPresence) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, presence: MeetPresence) => callback(presence);
    ipcRenderer.on("bridge:meet-presence", listener);
    return () => ipcRenderer.off("bridge:meet-presence", listener);
  },

  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
});

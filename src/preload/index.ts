/**
 * WarpTalk Desktop - Preload Script (Security Bridge)
 *
 * Exposes a safe API from main process to renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  ArmMeetWindowCaptureResult,
  AudioCaptureState,
  AudioCaptureStopped,
  DesktopRuntimeCapability,
  EnsureMeetCaptionsResult,
  MeetCaptionEvent,
  MeetCaptionStatus,
  MeetCallState,
  MeetMicState,
  MeetSelfMic,
  HiFiFormatAlignResult,
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
  getCaptureState: (): Promise<AudioCaptureState> =>
    ipcRenderer.invoke("audio:get-capture-state"),
  onAudioCaptureStopped: (callback: (event: AudioCaptureStopped) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AudioCaptureStopped) => callback(event);
    ipcRenderer.on("audio:capture-stopped", listener);
    return () => ipcRenderer.off("audio:capture-stopped", listener);
  },
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
  alignHiFiCableFormat: (): Promise<HiFiFormatAlignResult> =>
    ipcRenderer.invoke("bridge:align-hifi-format"),
  openTranscriptWindow: (roomId: string): Promise<void> =>
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
  // Brings the main window forward (tray, minimized, behind the browser). The popup stays open.
  showMainWindow: (): Promise<void> =>
    ipcRenderer.invoke("bridge:show-main-window"),
  // The user closed the popup. Never sent for a close the web app asked for.
  onTranscriptWindowClosed: (callback: (roomId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, roomId: string) => callback(roomId);
    ipcRenderer.on("bridge:transcript-window-closed", listener);
    return () => ipcRenderer.off("bridge:transcript-window-closed", listener);
  },
  // The app brought the popup back itself - the tray item, or a notification click.
  onTranscriptWindowReopened: (callback: (roomId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, roomId: string) => callback(roomId);
    ipcRenderer.on("bridge:transcript-window-reopened", listener);
    return () => ipcRenderer.off("bridge:transcript-window-reopened", listener);
  },
  watchMeetPresence: (): Promise<void> =>
    ipcRenderer.invoke("bridge:watch-meet-presence"),
  unwatchMeetPresence: (): Promise<void> =>
    ipcRenderer.invoke("bridge:unwatch-meet-presence"),
  onMeetPresence: (callback: (presence: MeetPresence) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, presence: MeetPresence) => callback(presence);
    ipcRenderer.on("bridge:meet-presence", listener);
    return () => ipcRenderer.off("bridge:meet-presence", listener);
  },

  // Optional on the web side. Never reporting leaves the session "unknown" to main.
  reportSignedIn: (signedIn: boolean): Promise<void> =>
    ipcRenderer.invoke("auth:signed-in-state", { signedIn }),

  // Speaker names from Meet's captions. See meet-captions.ts.
  onMeetCaption: (callback: (event: MeetCaptionEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: MeetCaptionEvent) => callback(event);
    ipcRenderer.on("bridge:meet-caption", listener);
    return () => ipcRenderer.off("bridge:meet-caption", listener);
  },
  onMeetCaptionStatus: (callback: (status: MeetCaptionStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: MeetCaptionStatus) => callback(status);
    ipcRenderer.on("bridge:meet-caption-status", listener);
    return () => ipcRenderer.off("bridge:meet-caption-status", listener);
  },
  setMeetCaptionsStream: (meetCode: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("bridge:meet-captions-stream", { meetCode, enabled }),
  ensureMeetCaptions: (meetCode: string): Promise<EnsureMeetCaptionsResult> =>
    ipcRenderer.invoke("bridge:ensure-meet-captions", { meetCode }),

  // Which mic Meet's browser records from (CABLE Output vs a real mic). See meet-mic-state.ts.
  setMeetMicStream: (enabled: boolean, options?: { browserPid?: number }): Promise<void> =>
    ipcRenderer.invoke("bridge:meet-mic-state-stream", { enabled, browserPid: options?.browserPid }),
  onMeetMicState: (callback: (state: MeetMicState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: MeetMicState) => callback(state);
    ipcRenderer.on("bridge:meet-mic-state", listener);
    return () => ipcRenderer.off("bridge:meet-mic-state", listener);
  },
  // One-shot: the next getDisplayMedia from the main window takes the sighted Meet window (WT-910).
  armMeetWindowCapture: (roomId: string): Promise<ArmMeetWindowCaptureResult> =>
    ipcRenderer.invoke("bridge:arm-meet-window-capture", roomId),

  // In the Meet call or not, and Meet's own mute button (tab or picture-in-picture). See
  // meet-call-state.ts. Fed by the presence watch; the getters are for a late subscriber.
  onMeetCallState: (callback: (state: MeetCallState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: MeetCallState) => callback(state);
    ipcRenderer.on("bridge:meet-call-state", listener);
    return () => ipcRenderer.off("bridge:meet-call-state", listener);
  },
  getMeetCallState: (): Promise<MeetCallState> =>
    ipcRenderer.invoke("bridge:get-meet-call-state"),
  onMeetSelfMic: (callback: (mic: MeetSelfMic) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mic: MeetSelfMic) => callback(mic);
    ipcRenderer.on("bridge:meet-self-mic", listener);
    return () => ipcRenderer.off("bridge:meet-self-mic", listener);
  },
  getMeetSelfMic: (): Promise<MeetSelfMic> =>
    ipcRenderer.invoke("bridge:get-meet-self-mic"),

  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
});

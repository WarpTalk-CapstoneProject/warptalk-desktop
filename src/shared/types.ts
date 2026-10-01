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
  onWindowsLoopbackPcmChunk: (callback: (chunk: WindowsLoopbackPcmChunk) => void) => () => void;
  joinTranslationRoom: (translationRoomId: string) => Promise<void>;
  leaveTranslationRoom: () => Promise<void>;
  onTranscript: (callback: (data: TranscriptUpdate) => void) => void;
  onTranslation: (callback: (data: TranslationUpdate) => void) => void;
  onConnectionStatus: (callback: (status: ConnectionStatus) => void) => void;
  openExternal: (url: string) => Promise<void>;
  getVirtualAudioStatus: () => Promise<VirtualAudioStatus>;
  installVirtualAudio: () => Promise<VirtualAudioInstallResult>;
  /**
   * Sets both Hi-Fi Cable endpoints to 2ch 24-bit 48 kHz. Windows only; absent on desktop builds
   * that predate it, so callers must check for it before calling.
   */
  alignHiFiCableFormat?: () => Promise<HiFiFormatAlignResult>;
  openTranscriptWindow: (roomId: string) => Promise<void>;
  activateRoom: (roomId: string) => Promise<void>;
  onRoomActivated: (callback: (roomId: string) => void) => () => void;
  closeTranscriptWindow: () => Promise<void>;
  /**
   * Restores, shows and focuses the main window (from the tray or minimized too) without touching
   * the bridge popup. Used when a bridge room ends: the web app navigates the main window to
   * `/rooms/{id}` and calls this. Absent on desktop builds that predate it.
   */
  showMainWindow?: () => Promise<void>;
  /** The user closed the popup; `roomId` is the room it showed. */
  onTranscriptWindowClosed: (callback: (roomId: string) => void) => () => void;
  /** The app reopened the popup itself, from the tray or a notification. */
  onTranscriptWindowReopened: (callback: (roomId: string) => void) => () => void;
  watchMeetPresence: () => Promise<void>;
  unwatchMeetPresence: () => Promise<void>;
  onMeetPresence: (callback: (presence: MeetPresence) => void) => () => void;
  /**
   * Tells main whether anyone is signed in, so a signed-out app can offer a sign-in when the user
   * is in a Google Meet call. Optional: never calling it leaves the state "unknown". Absent on
   * desktop builds that predate it.
   */
  reportSignedIn?: (signedIn: boolean) => Promise<void>;
  /**
   * Speaker names from Google Meet's own captions, for the meeting being bridged (Windows only,
   * behind the `bridgeMeetCaptionNames` flag). Start streaming with `setMeetCaptionsStream`; each
   * caption block is delivered once stable (`kind:"caption"`) and again if Meet rewrites it
   * (`kind:"update"`, same `blockId`). All optional: absent on desktop builds that predate them.
   */
  onMeetCaption?: (callback: (event: MeetCaptionEvent) => void) => () => void;
  onMeetCaptionStatus?: (callback: (status: MeetCaptionStatus) => void) => () => void;
  setMeetCaptionsStream?: (meetCode: string, enabled: boolean) => Promise<void>;
  /**
   * Turns Meet's CC on in the capturer's Chrome window if it is off - only via Meet's real CC
   * button, never focus or keys, never off. `ok:false` means ask the host to turn CC on manually.
   */
  ensureMeetCaptions?: (meetCode: string) => Promise<EnsureMeetCaptionsResult>;
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
  /** Hi-Fi Cable's two shared-mode formats. Windows only, when the cable is present and readable. */
  hifiFormat?: HiFiCableFormats;
  /** The two sides differ in sample rate or bit depth, so the inbound cable passes no sound. */
  hifiFormatMismatch?: boolean;
}

export interface EndpointFormat {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
}

export interface HiFiCableFormats {
  /** "Hi-Fi Cable Input", the render endpoint Meet plays into. */
  input: EndpointFormat | null;
  /** "Hi-Fi Cable Output", the capture endpoint WarpTalk records. */
  output: EndpointFormat | null;
}

export interface HiFiFormatAlignResult {
  /** True only when the read-back shows both endpoints at 48000 Hz/24-bit. */
  ok: boolean;
  before: HiFiCableFormats;
  after: HiFiCableFormats;
  error?: string;
}

export interface VirtualAudioRiskControl {
  id: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "B1" | "B2" | "X1";
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
      riskId: "R1" | "R2" | "R3" | "R5" | "R6" | "R7" | "R8" | "B2" | "X1";
      reason:
        | "unsupported-platform"
        | "driver-missing"
        | "process-loopback-unsupported"
        | "consent-required"
        | "target-process-required"
        | "target-source-unresolved"
        | "include-target-tree-required"
        | "native-loopback-adapter-unavailable"
        | "electron-loopback-api-not-ready"
        | "pcm-to-track-bridge-not-ready"
        | "silence-padding-not-ready"
        | "target-process-resolver-not-ready"
        | "target-is-warptalk";
    };

export interface WindowsLoopbackSource {
  id: string;
  name: string;
  windowHandle?: number;
  ownerProcessId?: number;
  likelyMeetingWindow: boolean;
}

/**
 * One observation of whether a Google Meet call is on screen.
 *
 * Raw on purpose. It says what a window title showed at a moment; it does not say which meeting
 * that is, whether the user has joined rather than sitting in the green room, or whether the
 * widget should be up. Those are decisions, they need tuning, and they live on the web side where
 * they can be tested without a desktop build.
 */
export interface MeetPresence {
  meetWindowVisible: boolean;
  /** Present only when the title carried a room code, which a named meeting never does. */
  meetCode?: string;
  observedAtMs: number;
}

/**
 * One caption block from Google Meet's CC, final enough to attribute a speaker.
 *
 * A speaker-name ANCHOR for attribution, not a transcript: WarpTalk's own STT writes the text.
 *
 * Times are ms on the Date.now() axis (monotonic within a session): `tStartMs` when the block
 * first appeared, `tEndMs` when its final text was first seen, `tStableMs` when it was judged
 * final. Captions trail speech by about 0.5-1.5 s. `tConfidence:"batch"` means the text arrived in
 * a burst (first read of a stream, after the tab was inactive/minimized, or Chrome held updates
 * back), so its times are not when it was said - match it by text. `stale` is true when the
 * sensor was not `live` at emission.
 */
export interface MeetCaptionEvent {
  meetCode: string;
  /** Stable for the block's life; an `update` replaces the earlier text of the same id. */
  blockId: string;
  kind: "caption" | "update";
  speaker: string;
  text: string;
  tStartMs: number;
  tEndMs: number;
  tStableMs: number;
  tConfidence: "live" | "batch";
  stale: boolean;
  source: "meet_caption";
}

/**
 * Sent when it changes. `state`:
 *   live                      the Meet tab is the active tab of a visible window and readable;
 *   unavailable_tab_inactive  no window's active tab is this meeting (tab switched - Meet's auto
 *                             picture-in-picture exposes no captions - closed, or the read failed);
 *   unavailable_minimized     the window holding the tab is minimized;
 *   stale                     readable, captions on, audio being captured, yet nothing changed for
 *                             8 s - silence, or Chrome holding accessibility updates back. A hint.
 * `captionsVisible` false while live means Meet's CC is off.
 */
export interface MeetCaptionStatus {
  meetCode: string;
  running: boolean;
  state: "live" | "unavailable_tab_inactive" | "unavailable_minimized" | "stale";
  captionsVisible: boolean;
  lastChangeMs: number | null;
  error?: string;
}

export interface EnsureMeetCaptionsResult {
  ok: boolean;
  state: "on" | "off" | "unknown";
  /**
   * Why not, e.g. "cc-button-hidden" (narrow window: CC is inside More options), "unknown-locale",
   * "meet-tab-not-found", "verify-button-not-flipped", "disabled", "unsupported-platform".
   */
  reason?: string;
}

export interface WindowsLoopbackPcmChunk {
  data: Uint8Array;
  format: "s16le";
  sampleRate: 48000;
  channelCount: 2;
  capturedAtMs: number;
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

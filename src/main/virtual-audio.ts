/**
 * Finding the virtual audio devices an EXTERNAL_BRIDGE meeting rides on.
 *
 * WarpTalk does not ship its own audio driver. Writing one means an AudioServerPlugIn on macOS
 * and, on Windows, a WDM driver signed with an EV certificate and attested by Microsoft — neither
 * is a thing this app can install on the user's behalf. So the bridge borrows an existing virtual
 * device and this module's job is to find it, describe it, and say plainly when it is missing.
 *
 * The bridge runs in both directions at once:
 *
 *   outbound  WarpTalk writes the dubbed voice here, and the user picks it as the MICROPHONE
 *             inside Google Meet.
 *   inbound   WarpTalk captures the far side's audio from the meeting app.
 *
 * macOS uses two BlackHole devices. Windows prefers two free VB-Audio cables — VB-CABLE out and
 * Hi-Fi Cable back — because pointing Meet's own speaker picker at the second cable captures the
 * Meet tab and nothing else. Where Hi-Fi Cable is not installed, inbound falls back to per-process
 * loopback, which takes the whole browser (R9) but still keeps the user's own dub out, because the
 * dub plays from WarpTalk's process tree.
 */

import fs from "fs";
import { spawnSync } from "child_process";
import os from "os";

import {
  isHiFiFormatMismatch,
  readHiFiCableFormatsCached,
  type HiFiCableFormats,
} from "./audio-device-format.ts";

/** Where macOS looks for audio HAL plug-ins. */
const MAC_HAL_DIRECTORY = "/Library/Audio/Plug-Ins/HAL";

export type BridgeLeg = "outbound" | "inbound";

export interface VirtualAudioDevice {
  leg: BridgeLeg;
  /** The bundle we look for on disk. */
  driverBundle: string;
  /** What the device is called in Google Meet's device picker — the string the user hunts for. */
  deviceName: string;
  installed: boolean;
  providerId?: string;
  providerName?: string;
  providerRole?: "primary" | "backup";
}

export interface VirtualAudioStatus {
  platform: NodeJS.Platform;
  /** False on a platform this module has no detection for yet, so callers never read a confident-looking false. */
  supported: boolean;
  devices: VirtualAudioDevice[];
  /** Both legs present. */
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
  /**
   * Other virtual drivers already on the machine. Not used for routing — they belong to other
   * applications — but worth surfacing, because "I already have a virtual mic" is the first thing
   * a user says when asked to install one, and naming theirs is how support conversations end.
   */
  foreignDrivers: string[];
  /**
   * Both Hi-Fi Cable endpoints' shared-mode formats. Windows only, and only when the cable is
   * on the inbound leg (listed in `devices`) and its formats could be read — absent means unknown, never "fine".
   */
  hifiFormat?: HiFiCableFormats;
  /** The two sides disagree on rate or depth, so the cable passes no sound. See audio-device-format.ts. */
  hifiFormatMismatch?: boolean;
  /**
   * Which bridge modes this machine can run right now. Additive: older readers ignore it, and a
   * status without it (an older desktop build) means "only voice mode exists".
   */
  bridgeModes?: BridgeModeAvailability;
  /**
   * The endpoint labels the renderer looks up in `enumerateDevices` to find each leg's device id,
   * and the names it shows the user. Additive and optional: a renderer that predates it keeps its
   * own copy of these names, and a status without it (an older desktop build) means "derive them".
   * Absent where the platform has no detection (`supported: false`).
   */
  endpointLabels?: BridgeEndpointLabels;
}

/**
 * Which endpoint each leg uses, for the provider pair this machine is on.
 *
 * A cable is two endpoints with opposite names, and the renderer needs both: it plays the dub INTO
 * one (`setSinkId`, an `audiooutput`) and the user picks the OTHER in Meet (an `audioinput`). On
 * macOS one duplex device carries both names, so the pair holds the same string twice.
 *
 * MATCHING: a label is matched case-insensitively as a SUBSTRING of a device label, which is how
 * the renderer has always matched. Every label here is chosen to be substring-safe against the
 * others: VB-CABLE's are full names because "CABLE Input" alone is inside "Hi-Fi Cable Input", and
 * Hi-Fi Cable's are stems because the "(VB-Audio …)" suffix it reports on Windows 10/11 is not yet
 * confirmed on a real machine (see WINDOWS_PROVIDERS).
 */
export interface BridgeEndpointLabels {
  /** The provider carrying the dub out (`vbcable-free`, `warptalk-audio`, `blackhole`). */
  outboundProviderId: string;
  /** Render endpoint WarpTalk plays the dub into. An `audiooutput`. */
  outboundSink: string;
  /** Capture endpoint the user selects as Meet's microphone. An `audioinput`. */
  meetMicrophone: string;
  /** The provider carrying the far side back (`hifi-cable-free`, …). */
  inboundProviderId: string | null;
  /** Capture endpoint WarpTalk records the far side from. An `audioinput`. */
  inboundCapture: string | null;
  /** Render endpoint Meet's speaker is pointed at when the far side comes back on the device. */
  meetSpeaker: string | null;
  /**
   * The bridge still runs without the inbound device. True on Windows, where process loopback (or,
   * on an old build, the outbound-only rung) takes over; false on macOS, where the second device is
   * the only way back.
   */
  inboundOptional: boolean;
}

/**
 * The two ways a bridge meeting can run, answered separately.
 *
 * TEXT-ONLY: Meet keeps the user's real microphone and speakers and no cable is involved. WarpTalk
 * captures the real mic itself and the far side through per-process loopback on the browser, and
 * shows transcript + translation only. It needs the loopback path and nothing else.
 *
 * VOICE: the dub has to reach the meeting, so Meet's microphone must be VB-CABLE's "CABLE Output",
 * and the far side has to come back on Hi-Fi Cable or through loopback.
 *
 * `bridgeMode` stays exactly what it was — it describes voice mode — so web code that reads it is
 * unaffected.
 */
export interface BridgeModeAvailability {
  textOnly: {
    possible: boolean;
    reason?: "unsupported-platform" | "process-loopback-unsupported" | "loopback-runtime-not-wired";
  };
  voice: {
    possible: boolean;
    /** VB-CABLE on Windows, the outbound device of the pair on macOS. */
    cableInstalled: boolean;
    /** How the far side would come back in voice mode. */
    inbound?: "hifi-cable" | "process-loopback" | "virtual-device";
    reason?: "unsupported-platform" | "cable-missing" | "inbound-unavailable";
  };
}

export interface VirtualAudioRiskControl {
  id: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "B1" | "B2" | "X1";
  status: "mitigated" | "guarded" | "implemented" | "known-limitation" | "requires-runtime";
  control: string;
}

interface MacDeviceSet {
  providerId: string;
  providerName: string;
  devices: ReadonlyArray<
    Omit<VirtualAudioDevice, "installed" | "providerId" | "providerName" | "providerRole">
  >;
}

/** One device's two endpoint labels as the renderer matches them. See BridgeEndpointLabels. */
interface EndpointPair {
  /** What something plays INTO. */
  render: string;
  /** What something records FROM. */
  capture: string;
}

/**
 * The two-device sets the bridge accepts on macOS, preferred first.
 *
 * WarpTalk's own pair is BlackHole's source built under WarpTalk's names by
 * scripts/build-mac-audio-driver.sh and installed from inside the app. It is not called BlackHole
 * because it may not be: BlackHole's source is GPL-3.0, and its licence withholds the name and
 * branding from modified builds. (This comment used to call BlackHole MIT-licensed; it is not.)
 *
 * Upstream BlackHole stays accepted, so every Mac set up before the rename keeps working. Within a
 * set, which device takes which leg is arbitrary but fixed — a user who configured Meet once would
 * otherwise find the directions swapped under them.
 */
const MAC_DEVICE_SETS: ReadonlyArray<MacDeviceSet> = [
  {
    providerId: "warptalk-audio",
    providerName: "WarpTalk Audio",
    devices: [
      { leg: "outbound", driverBundle: "WarpTalkMicrophone.driver", deviceName: "WarpTalk Microphone" },
      { leg: "inbound", driverBundle: "WarpTalkSpeaker.driver", deviceName: "WarpTalk Speaker" },
    ],
  },
  {
    providerId: "blackhole",
    providerName: "BlackHole",
    devices: [
      { leg: "outbound", driverBundle: "BlackHole2ch.driver", deviceName: "BlackHole 2ch" },
      { leg: "inbound", driverBundle: "BlackHole16ch.driver", deviceName: "BlackHole 16ch" },
    ],
  },
];

/** The driver bundles this app carries and installs itself. */
export const MAC_BUNDLED_DRIVERS: readonly string[] = MAC_DEVICE_SETS[0]!.devices.map(
  (device) => device.driverBundle,
);

interface VirtualAudioProvider {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  role: "primary" | "backup";
  mode: "full" | "outbound-only" | "inbound-only";
  runtime: "passive" | "requires-engine";
  devices: ReadonlyArray<Omit<VirtualAudioDevice, "installed" | "providerId" | "providerName">>;
  /**
   * The provider's other endpoint names, which are not routed through but are not foreign either.
   *
   * A cable is two endpoints. Detection keys on the one the user selects in Meet, and without this
   * its sibling — "CABLE Input", which the registry lists right beside "CABLE Output" — was reported
   * as somebody else's driver.
   */
  ownEndpoints?: readonly string[];
}

/** The second free cable. See WINDOWS_PROVIDERS. */
const WINDOWS_INBOUND_CABLE_ID = "hifi-cable-free";

const WINDOWS_PROCESS_LOOPBACK_MIN_BUILD = 20348;

const WINDOWS_FREE_CABLE_LOOPBACK_RISK_CONTROLS: ReadonlyArray<VirtualAudioRiskControl> = [
  {
    id: "R1",
    status: "mitigated",
    control: "C1a PASS proved INCLUDE_TARGET_PROCESS_TREE isolates Chrome audio from non-Chrome audio.",
  },
  {
    id: "R2",
    status: "guarded",
    control: "Start is blocked until the Electron loopback path is wired and chromeMediaSource:'desktop' is avoided.",
  },
  {
    id: "R3",
    status: "guarded",
    control: "Start is blocked until native PCM can be bridged to a publishable MediaStreamTrack.",
  },
  {
    id: "R4",
    status: "guarded",
    control: "The runtime path is gated behind the Electron loopback adapter so getDisplayMedia fallback cannot start implicitly.",
  },
  {
    id: "R5",
    status: "guarded",
    /**
     * "Scoped" used to appear here, and it was the wrong word: picking a window does not narrow the
     * capture to that window. Process loopback takes the whole browser (R9), so consent has to be
     * asked for what is actually taken. A picker that implies otherwise is a promise the capture
     * breaks.
     */
    control: "Start is blocked until the user consents to capturing every sound from the chosen browser, not only the meeting window.",
  },
  {
    id: "R6",
    status: "mitigated",
    /**
     * This used to read "Start is blocked until silence padding is available", and the padding it
     * named was the defect. Synthesising a silent buffer the length of each gap pushed the next
     * real frame a whole gap into the future, so the inbound leg's latency converged on the longest
     * silence the meeting had contained and never came back. A MediaStreamAudioDestinationNode
     * already emits silence for any unscheduled interval, so the published track was continuous
     * without it; removing the padding lets the scheduler re-anchor to the current time instead.
     */
    control: "No-packet gaps need no padding: the destination node emits silence for them, and the scheduler re-anchors to the current time after each gap.",
  },
  {
    id: "R7",
    status: "guarded",
    control: "Start requires includeTargetProcessTree=true so the loopback flag cannot be inverted silently.",
  },
  {
    id: "R8",
    status: "guarded",
    control: "Start is blocked until a selected Meet window resolves to the root browser process.",
  },
  {
    id: "R9",
    status: "known-limitation",
    /**
     * Measured, not assumed: two tabs of one browser instance playing 440 Hz and 1000 Hz were both
     * captured at identical amplitude by INCLUDE_TARGET_PROCESS_TREE on the browser process. The
     * browser renders every tab through one audio service inside that tree, so the tree is the
     * finest grain this API offers. R1 is still mitigated — the dub plays from our own process
     * tree and stays out — but a second noisy tab lands in the inbound leg and reaches the
     * pipeline as if the far side had said it.
     *
     * The only real fix is to give the meeting its own browser instance: a separate user-data-dir
     * gets its own browser process, and its tree then contains nothing else.
     */
    control: "Process loopback isolates the browser from the rest of the machine, not tab from tab; other audible tabs in the same browser instance are captured too.",
  },
  {
    id: "B1",
    status: "implemented",
    control: "Unknown VB-Audio/CABLE endpoints are surfaced as foreign drivers instead of becoming bridge providers.",
  },
  {
    id: "B2",
    status: "known-limitation",
    control: "The free VB-CABLE driver provides one cable; inbound rides the free Hi-Fi Cable when it is installed, and otherwise must use process loopback or a backup provider.",
  },
  {
    id: "X1",
    status: "implemented",
    control: "Setup opens the vendor download page and does not silently install drivers or change default devices.",
  },
];

const WINDOWS_PROVIDERS: ReadonlyArray<VirtualAudioProvider> = [
  {
    id: "vbcable-free",
    name: "VB-CABLE",
    platform: "win32",
    role: "primary",
    mode: "outbound-only",
    runtime: "passive",
    devices: [
      {
        leg: "outbound",
        driverBundle: "VB-CABLE",
        deviceName: "CABLE Output (VB-Audio Virtual Cable)",
      },
    ],
    ownEndpoints: ["CABLE Input (VB-Audio Virtual Cable)"],
  },
  /**
   * Hi-Fi Cable, VB-Audio's other free cable, carrying the far side back.
   *
   * Free for end users like VB-CABLE, and installable beside it — which is the point: two free
   * cables give Windows the same two-device bridge BlackHole gives macOS, without VB-CABLE A+B.
   * Meet's speaker is pointed at Hi-Fi Cable Input; WarpTalk records Hi-Fi Cable Output.
   *
   * Two things are not yet confirmed on a real Windows 10/11 machine: the exact "(VB-Audio …)"
   * suffix, which is why matching is by the stem, and the driver itself, whose download page still
   * lists Windows 8 as the newest release target. It also passes no sound unless both of its sides
   * share the exact same sample rate AND bit depth. The app aligns both endpoints to 24-bit 48 kHz
   * at runtime (audio-device-format.ts) and the status reports `hifiFormatMismatch`; the installer
   * used to try this by writing the registry, which never took effect.
   *
   * Not a separate recommendation: VB-CABLE stays `recommendedProviderId`, because it is the leg
   * without which nothing reaches the meeting at all. This one upgrades the inbound leg.
   */
  {
    id: WINDOWS_INBOUND_CABLE_ID,
    name: "Hi-Fi Cable",
    platform: "win32",
    role: "primary",
    mode: "inbound-only",
    runtime: "passive",
    devices: [
      {
        leg: "inbound",
        driverBundle: "Hi-Fi Cable",
        deviceName: "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)",
      },
    ],
    ownEndpoints: ["Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)"],
  },
  {
    id: "voicemeeter-banana",
    name: "Voicemeeter Banana",
    platform: "win32",
    role: "backup",
    mode: "full",
    runtime: "requires-engine",
    devices: [
      {
        leg: "outbound",
        driverBundle: "Voicemeeter AUX",
        deviceName: "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)",
      },
      {
        leg: "inbound",
        driverBundle: "Voicemeeter VAIO",
        deviceName: "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)",
      },
    ],
  },
];

/**
 * The two free Windows cables' endpoints, as the renderer matches them.
 *
 * Always these two, whatever else is installed: they are the only Windows route the renderer
 * plays through. Voicemeeter is reported in `devices` for support, but its endpoints only carry
 * sound while its mixer runs ("installed-not-running"), and the renderer has never routed into it.
 */
const VBCABLE_ENDPOINTS: EndpointPair = {
  render: "CABLE Input (VB-Audio Virtual Cable)",
  capture: "CABLE Output (VB-Audio Virtual Cable)",
};
/** Stems on purpose: the suffix is unconfirmed, and neither stem is inside a VB-CABLE name. */
const HIFI_CABLE_ENDPOINTS: EndpointPair = {
  render: "Hi-Fi Cable Input",
  capture: "Hi-Fi Cable Output",
};

export function windowsEndpointLabels(): BridgeEndpointLabels {
  return {
    outboundProviderId: "vbcable-free",
    outboundSink: VBCABLE_ENDPOINTS.render,
    meetMicrophone: VBCABLE_ENDPOINTS.capture,
    inboundProviderId: WINDOWS_INBOUND_CABLE_ID,
    inboundCapture: HIFI_CABLE_ENDPOINTS.capture,
    meetSpeaker: HIFI_CABLE_ENDPOINTS.render,
    inboundOptional: true,
  };
}

/** A Mac pair is two duplex devices: each one's single name is both of its endpoints. */
function macEndpointLabels(set: MacDeviceSet): BridgeEndpointLabels {
  const outbound = set.devices.find((device) => device.leg === "outbound")!;
  const inbound = set.devices.find((device) => device.leg === "inbound") ?? null;
  return {
    outboundProviderId: set.providerId,
    outboundSink: outbound.deviceName,
    meetMicrophone: outbound.deviceName,
    inboundProviderId: inbound ? set.providerId : null,
    inboundCapture: inbound?.deviceName ?? null,
    meetSpeaker: inbound?.deviceName ?? null,
    inboundOptional: false,
  };
}

function withProvider(
  provider: VirtualAudioProvider,
  device: Omit<VirtualAudioDevice, "installed" | "providerId" | "providerName" | "providerRole">,
  installed: boolean,
): VirtualAudioDevice {
  return {
    ...device,
    installed,
    providerId: provider.id,
    providerName: provider.name,
    providerRole: provider.role,
  };
}

/** Bundles that belong to something else, so they are reported rather than used. */
function isOurs(bundle: string): boolean {
  return MAC_DEVICE_SETS.some((set) => set.devices.some((device) => device.driverBundle === bundle));
}

function readHalDirectory(): string[] {
  try {
    return fs.readdirSync(MAC_HAL_DIRECTORY).filter((entry) => entry.endsWith(".driver"));
  } catch {
    // Absent on a machine that has never had a plug-in installed. Not an error.
    return [];
  }
}

function windowsBuildNumber(): number {
  return Number.parseInt(os.release().split(".").at(-1) ?? "0", 10);
}

function normalizeDeviceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether one registry string names `expected`.
 *
 * The registry lists an endpoint under several strings — the friendly name "CABLE Output
 * (VB-Audio Virtual Cable)" and the bare description "CABLE Output" among them — so the stem before
 * the parenthesis has to match on its own. It used to match as a SUBSTRING, and that stopped being
 * safe the moment a second cable was registered: "cable output" is inside "Hi-Fi Cable Output", so a
 * machine with only Hi-Fi Cable read as having VB-CABLE. The stem now has to START the name.
 */
export function matchesDeviceName(name: string, expected: string): boolean {
  const candidate = normalizeDeviceName(name);
  const stem = normalizeDeviceName(expected.split(" (")[0] ?? expected);
  return candidate === normalizeDeviceName(expected) || candidate === stem || candidate.startsWith(`${stem} (`);
}

function includesDeviceName(names: ReadonlySet<string>, expected: string): boolean {
  for (const name of names) {
    if (matchesDeviceName(name, expected)) return true;
  }
  return false;
}

/**
 * The endpoint names to describe: this read's, or the last read's that worked when this one failed.
 *
 * WHY
 *   The read is a PowerShell spawn with a 2.5 s limit, and on a busy machine it runs out. Its
 *   empty answer used to mean "no virtual device installed": on 2026-10-03 23:06Z a call whose
 *   Meet microphone WAS the cable was refused browser loopback with B2 driver-missing (the IPC
 *   took 2543 ms), fell back to a virtual speaker Meet was not playing into, and heard nothing
 *   from the far side for the whole call. A read that failed says nothing about the devices, and
 *   a driver does not uninstall itself between two reads. With no earlier read to go by the
 *   answer stays empty, which fails closed.
 */
export function lastGoodEndpointNames(
  read: () => string[] | null,
  onFailedRead: (kept: number) => void = () => undefined,
): () => readonly string[] {
  let last: readonly string[] | null = null;
  return () => {
    const names = read();
    if (names) {
      last = names;
      return names;
    }
    onFailedRead(last?.length ?? 0);
    return last ?? [];
  };
}

/** Null when the read itself failed (timed out, errored, unparseable): unknown, not "none". */
function readWindowsAudioEndpointNames(): string[] | null {
  const script = String.raw`
$ErrorActionPreference = "SilentlyContinue"
$roots = @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture",
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
)
$names = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root | Where-Object {
    try { (Get-ItemProperty -LiteralPath $_.PSPath -Name DeviceState).DeviceState -eq 1 } catch { $false }
  } | ForEach-Object {
    $props = Get-ItemProperty -LiteralPath (Join-Path $_.PSPath "Properties")
    foreach ($property in $props.PSObject.Properties) {
      if ($property.Value -is [string] -and $property.Value -match "VB-Audio|CABLE|VoiceMeeter|Voicemeeter") {
        $property.Value
      }
    }
  }
}
$names | Sort-Object -Unique | ConvertTo-Json -Compress
`;

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 2500,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  // The script ran and matched nothing: no virtual device, which is an answer.
  if (!result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return null;
  }
}

const windowsAudioEndpointNames = lastGoodEndpointNames(readWindowsAudioEndpointNames, (kept) => {
  console.warn(`Audio endpoint read failed; keeping the last list that was read (${kept} name(s)).`);
});

/**
 * `runtimeReady` is asked for rather than inferred.
 *
 * The build number says the OS *offers* process loopback; it says nothing about whether the native
 * addon loaded, the PCM bridge exists, or a window can be resolved to a PID. Those live in the
 * runtime adapter, and the caller that owns it passes the answer in. Defaulting to false keeps the
 * conservative reading for anyone who cannot answer: an under-reported capability costs a rung, an
 * over-reported one costs a silent half-dead meeting.
 */
export function describeWindowsVirtualAudioForEndpoints(
  endpointNamesList: readonly string[],
  buildNumber: number,
  runtimeReady = false,
): VirtualAudioStatus {
  const endpointNames = new Set(endpointNamesList);
  const providers = WINDOWS_PROVIDERS.map((provider) => {
    const devices = provider.devices.map((device) =>
      withProvider(provider, device, includesDeviceName(endpointNames, device.deviceName)),
    );
    return { provider, devices, ready: devices.every((device) => device.installed) };
  });

  const primaryProvider = providers.find(({ provider }) => provider.role === "primary");
  if (!primaryProvider) {
    throw new Error("Windows virtual audio provider registry has no primary provider.");
  }
  const outboundProvider = providers.find(
    ({ provider, ready }) => provider.role === "primary" && provider.mode === "outbound-only" && ready,
  );
  const installedBackupProvider = providers.find(
    ({ provider, ready }) =>
      provider.role === "backup" && provider.runtime === "requires-engine" && ready,
  );
  const inboundCable = providers.find(
    ({ provider, ready }) => provider.id === WINDOWS_INBOUND_CABLE_ID && ready,
  );
  const processLoopback = buildNumber >= WINDOWS_PROCESS_LOOPBACK_MIN_BUILD;
  // Both free cables make a full bridge on their own, with no process loopback involved — so it
  // holds on a Windows build too old for loopback, and it outranks an installed Voicemeeter.
  const twoFreeCables = outboundProvider && inboundCable ? { outboundProvider, inboundCable } : null;
  const detectedProvider =
    (processLoopback ? outboundProvider : undefined) ??
    installedBackupProvider ??
    outboundProvider ??
    primaryProvider;
  const loopbackUsable = processLoopback && runtimeReady;
  const bridgeModes: BridgeModeAvailability = {
    textOnly: loopbackUsable
      ? { possible: true }
      : {
          possible: false,
          reason: processLoopback ? "loopback-runtime-not-wired" : "process-loopback-unsupported",
        },
    voice: !outboundProvider
      ? { possible: false, cableInstalled: false, reason: "cable-missing" }
      : twoFreeCables
        ? { possible: true, cableInstalled: true, inbound: "hifi-cable" }
        : loopbackUsable
          ? { possible: true, cableInstalled: true, inbound: "process-loopback" }
          : { possible: false, cableInstalled: true, reason: "inbound-unavailable" },
  };
  const mode = twoFreeCables
    ? "full"
    : outboundProvider && processLoopback
      ? "outbound-only"
      : installedBackupProvider
        ? "installed-not-running"
        : "caption-only";

  return {
    platform: "win32",
    supported: true,
    // VB-CABLE first, as everywhere else: the loopback start gate looks for it by provider id, and
    // it is still the device the dub leaves through.
    devices: twoFreeCables
      ? [...twoFreeCables.outboundProvider.devices, ...twoFreeCables.inboundCable.devices]
      : detectedProvider.devices,
    ready: twoFreeCables !== null,
    bridgeMode: mode,
    recommendedProviderId: primaryProvider.provider.id,
    capabilities: {
      fullBridge: twoFreeCables !== null,
      outboundOnly: mode === "outbound-only" || mode === "full",
      captionOnly: true,
      processLoopback,
      processLoopbackRuntime: processLoopback && runtimeReady ? "available" : "not-wired",
      minWindowsProcessLoopbackBuild: WINDOWS_PROCESS_LOOPBACK_MIN_BUILD,
    },
    riskControls: [...WINDOWS_FREE_CABLE_LOOPBACK_RISK_CONTROLS],
    bridgeModes,
    endpointLabels: windowsEndpointLabels(),
    foreignDrivers: Array.from(endpointNames).filter(
      (name) =>
        !WINDOWS_PROVIDERS.some(
          (provider) =>
            provider.devices.some((device) => matchesDeviceName(name, device.deviceName)) ||
            (provider.ownEndpoints ?? []).some((endpoint) => matchesDeviceName(name, endpoint)),
        ),
    ),
  };
}

function detectWindowsVirtualAudio(runtimeReady: boolean): VirtualAudioStatus {
  return describeWindowsVirtualAudioForEndpoints(
    windowsAudioEndpointNames(),
    windowsBuildNumber(),
    runtimeReady,
  );
}

/**
 * `runtimeReady` comes from the caller that owns the loopback runtime, because this module cannot
 * import it without a cycle — the runtime already imports `detectVirtualAudio` as its own default
 * status source. Omitting it reports the capture path as not wired, which is the reading that fails
 * closed.
 */
export function detectVirtualAudio(runtimeReady = false): VirtualAudioStatus {
  if (process.platform === "win32") return detectWindowsVirtualAudio(runtimeReady);

  if (process.platform !== "darwin") {
    // Windows needs VB-CABLE, whose redistribution is licensed, and detection there reads the
    // device registry rather than a directory. Reporting `supported: false` keeps the UI honest
    // instead of showing an empty list that looks like "nothing installed".
    return {
      platform: process.platform,
      supported: false,
      devices: [],
      ready: false,
      bridgeMode: "caption-only",
      capabilities: {
        fullBridge: false,
        outboundOnly: false,
        captionOnly: true,
        processLoopback: false,
        processLoopbackRuntime: "not-wired",
      },
      riskControls: [],
      bridgeModes: {
        textOnly: { possible: false, reason: "unsupported-platform" },
        voice: { possible: false, cableInstalled: false, reason: "unsupported-platform" },
      },
      foreignDrivers: [],
    };
  }

  return describeMacVirtualAudio(readHalDirectory());
}

/**
 * `detectVirtualAudio` plus the Hi-Fi Cable formats, for the status the web app reads.
 *
 * Kept apart from `detectVirtualAudio`, which stays synchronous for the loopback runtime and the
 * capability probe that call it on their own paths. A failed read omits the fields rather than
 * failing the status: the cable may still work, and a status error would hide every other leg.
 *
 * The read is cached and shared (readHiFiCableFormatsCached): the web app asks for this status on
 * every devicechange, and an uncached read is a PowerShell spawn of about two seconds each time.
 */
export async function detectVirtualAudioWithFormats(
  runtimeReady = false,
  readFormats: () => Promise<HiFiCableFormats> = readHiFiCableFormatsCached,
): Promise<VirtualAudioStatus> {
  const status = detectVirtualAudio(runtimeReady);
  return withHiFiCableFormat(status, readFormats);
}

/**
 * Whether the status puts Hi-Fi Cable on the inbound leg.
 *
 * The status lists Hi-Fi Cable only when it forms the full bridge with VB-CABLE. Anywhere else its
 * format decides nothing — inbound is not riding it — so there is nothing worth a PowerShell spawn.
 */
function usesHiFiCable(status: VirtualAudioStatus): boolean {
  return status.devices.some((device) => device.providerId === WINDOWS_INBOUND_CABLE_ID && device.installed);
}

export async function withHiFiCableFormat(
  status: VirtualAudioStatus,
  readFormats: () => Promise<HiFiCableFormats> = readHiFiCableFormatsCached,
): Promise<VirtualAudioStatus> {
  if (status.platform !== "win32" || !usesHiFiCable(status)) return status;
  try {
    const formats = await readFormats();
    if (!formats.input && !formats.output) return status;
    return { ...status, hifiFormat: formats, hifiFormatMismatch: isHiFiFormatMismatch(formats) };
  } catch (error) {
    console.warn("Could not read the Hi-Fi Cable formats:", error);
    return status;
  }
}

/**
 * Which accepted pair a Mac is using, from the bundles in its HAL directory.
 *
 * The pair with more devices installed wins, and WarpTalk's own on a tie. Choosing by count rather
 * than "any WarpTalk device present" keeps a Mac with a complete BlackHole install on BlackHole
 * while a WarpTalk install is half done, instead of swapping the names the user selected in Meet
 * for two devices that do not all exist yet.
 */
export function describeMacVirtualAudio(presentBundles: readonly string[]): VirtualAudioStatus {
  const candidates = MAC_DEVICE_SETS.map((set, index) => {
    const devices: VirtualAudioDevice[] = set.devices.map((device) => ({
      ...device,
      installed: presentBundles.includes(device.driverBundle),
      providerId: set.providerId,
      providerName: set.providerName,
      providerRole: index === 0 ? "primary" : "backup",
    }));
    return { set, devices, installedCount: devices.filter((device) => device.installed).length };
  });
  const chosen = candidates.reduce((best, next) =>
    next.installedCount > best.installedCount ? next : best,
  );
  const ready = chosen.devices.every((device) => device.installed);

  return {
    platform: "darwin",
    supported: true,
    devices: chosen.devices,
    ready,
    bridgeMode: ready ? "full" : "caption-only",
    recommendedProviderId: MAC_DEVICE_SETS[0]!.providerId,
    capabilities: {
      fullBridge: ready,
      outboundOnly: ready,
      captionOnly: true,
      processLoopback: false,
      processLoopbackRuntime: "not-wired",
    },
    riskControls: [],
    // No per-process loopback on macOS, so no text-only path yet: inbound needs the second device.
    bridgeModes: {
      textOnly: { possible: false, reason: "process-loopback-unsupported" },
      voice: ready
        ? { possible: true, cableInstalled: true, inbound: "virtual-device" }
        : {
            possible: false,
            cableInstalled: chosen.devices.some((device) => device.leg === "outbound" && device.installed),
            reason: chosen.devices.some((device) => device.leg === "outbound" && device.installed)
              ? "inbound-unavailable"
              : "cable-missing",
          },
    },
    foreignDrivers: presentBundles.filter((bundle) => !isOurs(bundle)),
    // The pair chosen above, so the renderer's routing follows the same choice as `devices`.
    endpointLabels: macEndpointLabels(chosen.set),
  };
}

/** Whether any virtual audio driver at all is on the machine. */
export function hasAnyVirtualDriver(): boolean {
  if (process.platform === "win32") return windowsAudioEndpointNames().length > 0;
  if (process.platform !== "darwin") return false;
  return readHalDirectory().length > 0;
}

/** Where BlackHole is published. Its GitHub releases carry no installer package. */
export const BLACKHOLE_DOWNLOAD_PAGE = "https://existential.audio/blackhole/";

/** Where VB-Audio publishes the free single-cable Windows driver. */
export const VBCABLE_DOWNLOAD_PAGE = "https://vb-audio.com/Cable/";

/**
 * The Homebrew command that installs both legs.
 *
 * Offered as text to copy rather than run for us. The package writes into /Library and needs an
 * administrator, and a GUI app that silently drives a privilege prompt the user did not initiate
 * is indistinguishable from something they should refuse. Handing over the exact command keeps
 * both the decision and the password with the person at the keyboard.
 */
export const BLACKHOLE_BREW_COMMAND =
  "brew install --cask blackhole-2ch blackhole-16ch";

/** Whether Homebrew is on this machine, so the UI can offer the command that will actually work. */
export function hasHomebrew(): boolean {
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].some((candidate) =>
    fs.existsSync(candidate),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell script that installs WarpTalk's own audio devices, run once with administrator rights.
 *
 * Mirrors what BlackHole's installer package does in its pre- and postinstall scripts: the HAL
 * directory owned by root:wheel, the bundle root:wheel with 755 directories and 644 files, its
 * executable 755. Two additions. The quarantine flag is stripped, because `cp` carries it over
 * from a downloaded app. And coreaudiod is restarted, which is what makes the devices appear now
 * rather than after the reboot BlackHole's own installer asks for.
 *
 * A bundle of the same name is replaced, so installing again is how an update is applied. Nothing
 * else in the HAL directory is touched, and a bundle name that is not a plain `Name.driver` is
 * refused before any of it runs.
 */
export function buildMacDriverInstallScript(
  sourceDirectory: string,
  bundles: readonly string[] = MAC_BUNDLED_DRIVERS,
): string {
  const hal = shellQuote(MAC_HAL_DIRECTORY);
  const steps = ["set -e", `mkdir -p ${hal}`, `chown root:wheel ${hal}`, `chmod 755 ${hal}`];

  for (const bundle of bundles) {
    if (!/^[A-Za-z0-9]+\.driver$/.test(bundle)) {
      throw new Error(`Refusing to install an unexpected driver bundle name: ${bundle}`);
    }
    const target = shellQuote(`${MAC_HAL_DIRECTORY}/${bundle}`);
    steps.push(
      `rm -rf ${target}`,
      `cp -R ${shellQuote(`${sourceDirectory}/${bundle}`)} ${target}`,
      `xattr -dr com.apple.quarantine ${target} || true`,
      `chown -R root:wheel ${target}`,
      `find ${target} -type d -exec chmod 755 {} +`,
      `find ${target} -type f -exec chmod 644 {} +`,
      `chmod 755 ${target}/Contents/MacOS/*`,
    );
  }

  steps.push("killall coreaudiod || true");
  return steps.join("; ");
}

/**
 * The AppleScript that runs `script` as administrator.
 *
 * `do shell script ... with administrator privileges` puts up macOS's own password prompt, so the
 * password goes to macOS and never passes through WarpTalk. The script travels as an AppleScript
 * string literal, in which only backslash and double quote are special.
 */
export function toAppleScriptAdminCommand(script: string): string {
  const literal = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `do shell script "${literal}" with administrator privileges`;
}

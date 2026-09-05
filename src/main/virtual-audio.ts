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
 * macOS uses two BlackHole devices. Windows primary uses one free VB-CABLE device for outbound
 * and per-process loopback for inbound, so the user's own dub is outside the captured process
 * tree instead of being separated by a second cable.
 */

import fs from "fs";
import { spawnSync } from "child_process";
import os from "os";

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
}

export interface VirtualAudioRiskControl {
  id: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "B1" | "B2" | "X1";
  status: "mitigated" | "guarded" | "implemented" | "known-limitation" | "requires-runtime";
  control: string;
}

/**
 * BlackHole is the device the bridge targets on macOS: it is MIT licensed, so it can be
 * redistributed, and it installs several independent variants side by side, which is exactly what
 * the two-device requirement needs. 2ch carries the outbound voice and 16ch the inbound mix;
 * which variant takes which leg is arbitrary, but it has to stay fixed or a user who configured
 * Meet once would find the directions swapped under them.
 */
const MAC_DEVICES: ReadonlyArray<Omit<VirtualAudioDevice, "installed">> = [
  { leg: "outbound", driverBundle: "BlackHole2ch.driver", deviceName: "BlackHole 2ch" },
  { leg: "inbound", driverBundle: "BlackHole16ch.driver", deviceName: "BlackHole 16ch" },
];

interface VirtualAudioProvider {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  role: "primary" | "backup";
  mode: "full" | "outbound-only";
  runtime: "passive" | "requires-engine";
  devices: ReadonlyArray<Omit<VirtualAudioDevice, "installed" | "providerId" | "providerName">>;
}

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
    control: "Start is blocked until the user grants scoped capture consent from the meeting-window picker.",
  },
  {
    id: "R6",
    status: "guarded",
    control: "Start is blocked until silence padding is available for no-packet gaps in the loopback stream.",
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
    control: "The free VB-CABLE driver provides one cable; inbound must use process loopback or a backup provider.",
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
  return MAC_DEVICES.some((device) => device.driverBundle === bundle);
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

function includesDeviceName(names: ReadonlySet<string>, expected: string): boolean {
  const needle = normalizeDeviceName(expected.split(" (")[0] ?? expected);
  for (const name of names) {
    if (normalizeDeviceName(name).includes(needle)) return true;
  }
  return false;
}

function readWindowsAudioEndpointNames(): string[] {
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
  if (result.status !== 0 || !result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
}

export function describeWindowsVirtualAudioForEndpoints(
  endpointNamesList: readonly string[],
  buildNumber: number,
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
  const processLoopback = buildNumber >= WINDOWS_PROCESS_LOOPBACK_MIN_BUILD;
  const detectedProvider =
    (processLoopback ? outboundProvider : undefined) ??
    installedBackupProvider ??
    outboundProvider ??
    primaryProvider;
  const mode = outboundProvider && processLoopback
    ? "outbound-only"
    : installedBackupProvider
      ? "installed-not-running"
      : "caption-only";

  return {
    platform: "win32",
    supported: true,
    devices: detectedProvider.devices,
    ready: false,
    bridgeMode: mode,
    recommendedProviderId: primaryProvider.provider.id,
    capabilities: {
      fullBridge: false,
      outboundOnly: mode === "outbound-only",
      captionOnly: true,
      processLoopback,
      processLoopbackRuntime: processLoopback ? "available" : "not-wired",
      minWindowsProcessLoopbackBuild: WINDOWS_PROCESS_LOOPBACK_MIN_BUILD,
    },
    riskControls: [...WINDOWS_FREE_CABLE_LOOPBACK_RISK_CONTROLS],
    foreignDrivers: Array.from(endpointNames).filter(
      (name) =>
        !WINDOWS_PROVIDERS.some((provider) =>
          provider.devices.some((device) => includesDeviceName(new Set([name]), device.deviceName)),
        ),
    ),
  };
}

function detectWindowsVirtualAudio(): VirtualAudioStatus {
  return describeWindowsVirtualAudioForEndpoints(
    readWindowsAudioEndpointNames(),
    windowsBuildNumber(),
  );
}

export function detectVirtualAudio(): VirtualAudioStatus {
  if (process.platform === "win32") return detectWindowsVirtualAudio();

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
      foreignDrivers: [],
    };
  }

  const present = readHalDirectory();
  const devices = MAC_DEVICES.map((device) => ({
    ...device,
    installed: present.includes(device.driverBundle),
  }));

  return {
    platform: process.platform,
    supported: true,
    devices,
    ready: devices.every((device) => device.installed),
    bridgeMode: devices.every((device) => device.installed) ? "full" : "caption-only",
    recommendedProviderId: "blackhole",
    capabilities: {
      fullBridge: devices.every((device) => device.installed),
      outboundOnly: devices.every((device) => device.installed),
      captionOnly: true,
      processLoopback: false,
      processLoopbackRuntime: "not-wired",
    },
    riskControls: [],
    foreignDrivers: present.filter((bundle) => !isOurs(bundle)),
  };
}

/** Whether any virtual audio driver at all is on the machine. */
export function hasAnyVirtualDriver(): boolean {
  if (process.platform === "win32") return readWindowsAudioEndpointNames().length > 0;
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

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

interface MacDeviceSet {
  providerId: string;
  providerName: string;
  devices: ReadonlyArray<
    Omit<VirtualAudioDevice, "installed" | "providerId" | "providerName" | "providerRole">
  >;
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
   * are set to the same sample rate, which the setup copy tells the user.
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
function matchesDeviceName(name: string, expected: string): boolean {
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
    readWindowsAudioEndpointNames(),
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
      foreignDrivers: [],
    };
  }

  return describeMacVirtualAudio(readHalDirectory());
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
    return { devices, installedCount: devices.filter((device) => device.installed).length };
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
    foreignDrivers: presentBundles.filter((bundle) => !isOurs(bundle)),
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

/**
 * Finding the virtual audio devices an EXTERNAL_BRIDGE meeting rides on.
 *
 * WarpTalk does not ship its own audio driver. Writing one means an AudioServerPlugIn on macOS
 * and, on Windows, a WDM driver signed with an EV certificate and attested by Microsoft — neither
 * is a thing this app can install on the user's behalf. So the bridge borrows an existing virtual
 * device and this module's job is to find it, describe it, and say plainly when it is missing.
 *
 * Two independent devices are needed, because the bridge runs in both directions at once:
 *
 *   outbound  WarpTalk writes the dubbed voice here, and the user picks it as the MICROPHONE
 *             inside Google Meet.
 *   inbound   the user picks it as the SPEAKER inside Google Meet, and WarpTalk reads the far
 *             side's audio back out of it.
 *
 * One device cannot do both: whatever is written to it is what is read from it, so a single
 * device would feed the user's own dubbed voice straight back into the pipeline.
 */

import fs from "fs";
import path from "path";

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
}

export interface VirtualAudioStatus {
  platform: NodeJS.Platform;
  /** False on a platform this module has no detection for yet, so callers never read a confident-looking false. */
  supported: boolean;
  devices: VirtualAudioDevice[];
  /** Both legs present. */
  ready: boolean;
  /**
   * Other virtual drivers already on the machine. Not used for routing — they belong to other
   * applications — but worth surfacing, because "I already have a virtual mic" is the first thing
   * a user says when asked to install one, and naming theirs is how support conversations end.
   */
  foreignDrivers: string[];
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

export function detectVirtualAudio(): VirtualAudioStatus {
  if (process.platform !== "darwin") {
    // Windows needs VB-CABLE, whose redistribution is licensed, and detection there reads the
    // device registry rather than a directory. Reporting `supported: false` keeps the UI honest
    // instead of showing an empty list that looks like "nothing installed".
    return {
      platform: process.platform,
      supported: false,
      devices: [],
      ready: false,
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
    foreignDrivers: present.filter((bundle) => !isOurs(bundle)),
  };
}

/** Whether any virtual audio driver at all is on the machine. */
export function hasAnyVirtualDriver(): boolean {
  if (process.platform !== "darwin") return false;
  return readHalDirectory().length > 0;
}

/**
 * Path to the bundled BlackHole installer, or null when it was not packaged.
 *
 * Installing writes into /Library and therefore needs an administrator, which is why nothing here
 * runs it silently — the caller shows what is about to happen and why first.
 */
export function bundledInstallerPath(resourcesPath: string, isPackaged: boolean): string | null {
  const candidate = isPackaged
    ? path.join(resourcesPath, "BlackHole.pkg")
    : path.resolve(process.cwd(), "resources", "BlackHole.pkg");

  return fs.existsSync(candidate) ? candidate : null;
}

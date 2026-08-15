import { createHash } from "crypto";
import os from "os";
import { performance } from "perf_hooks";

import type { DesktopRuntimeCapability } from "../shared/types";
import { detectVirtualAudio, hasAnyVirtualDriver } from "./virtual-audio";

export class AudioRuntimeService {
  async getCapability(): Promise<DesktopRuntimeCapability> {
    const start = performance.now();
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const availableMb = Math.round(os.freemem() / 1024 / 1024);
    const virtualAudio = detectVirtualAudio();

    return {
      deviceIdHash: this.deviceHash(),
      os: `${process.platform}-${process.arch}`,
      ramTotalMb: totalMb,
      ramAvailableMb: availableMb,
      cpuCores: os.cpus().length,
      gpuType: "unknown",
      supportsLocalPiper: false,
      supportsLocalClone: false,
      // Both flags shipped hardcoded false from the first commit. They mean different things and
      // an external-bridge meeting needs the second one: `audioDriverReady` is "this machine can
      // host a virtual device at all", `virtualMicReady` is "both legs of the bridge are present
      // and it could run right now".
      audioDriverReady: hasAnyVirtualDriver(),
      virtualMicReady: virtualAudio.ready,
      lastProbeLatencyMs: Math.round(performance.now() - start),
    };
  }

  private deviceHash(): string {
    const raw = `${os.hostname()}|${process.platform}|${process.arch}|${os.cpus().length}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }
}

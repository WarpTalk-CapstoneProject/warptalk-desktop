import { createHash } from "crypto";
import os from "os";
import { performance } from "perf_hooks";

import type { DesktopRuntimeCapability } from "../shared/types";

export class AudioRuntimeService {
  async getCapability(): Promise<DesktopRuntimeCapability> {
    const start = performance.now();
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const availableMb = Math.round(os.freemem() / 1024 / 1024);

    return {
      deviceIdHash: this.deviceHash(),
      os: `${process.platform}-${process.arch}`,
      ramTotalMb: totalMb,
      ramAvailableMb: availableMb,
      cpuCores: os.cpus().length,
      gpuType: "unknown",
      supportsLocalPiper: false,
      supportsLocalClone: false,
      audioDriverReady: false,
      virtualMicReady: false,
      lastProbeLatencyMs: Math.round(performance.now() - start),
    };
  }

  private deviceHash(): string {
    const raw = `${os.hostname()}|${process.platform}|${process.arch}|${os.cpus().length}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }
}

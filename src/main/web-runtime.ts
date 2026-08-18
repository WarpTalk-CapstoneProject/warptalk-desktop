import { app } from "electron";
import { fork, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";

const DESKTOP_ENTRY_PATH = "/desktop-login";
const DEFAULT_DEV_URL = `http://localhost:3000${DESKTOP_ENTRY_PATH}`;
const DEFAULT_REMOTE_PROD_URL = `https://app.warptalk.io.vn${DESKTOP_ENTRY_PATH}`;
const DEFAULT_PROD_PORT = 3030;

export class WebRuntimeService {
  private serverProcess: ChildProcess | null = null;
  private rendererUrl: string | null = null;

  async getRendererUrl(): Promise<string> {
    const configuredWebUrl = process.env.WARPTALK_WEB_URL?.trim();

    if (process.env.NODE_ENV === "development") {
      return configuredWebUrl || DEFAULT_DEV_URL;
    }

    if (configuredWebUrl) {
      return configuredWebUrl;
    }

    const requestedMode = process.env.WARPTALK_DESKTOP_WEB_MODE?.trim();
    const shouldUseLocalRuntime =
      requestedMode === "local" ||
      (requestedMode !== "remote" && this.hasStandaloneServer());

    if (!shouldUseLocalRuntime) {
      return DEFAULT_REMOTE_PROD_URL;
    }

    if (this.rendererUrl) {
      return this.rendererUrl;
    }

    const port = await findAvailablePort(
      Number(process.env.WARPTALK_WEB_PORT || DEFAULT_PROD_PORT),
    );
    const url = `http://127.0.0.1:${port}${DESKTOP_ENTRY_PATH}`;
    const serverPath = this.resolveStandaloneServerPath();

    this.serverProcess = fork(serverPath, [], {
      cwd: path.dirname(serverPath),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NEXT_TELEMETRY_DISABLED: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      execPath: process.execPath,
      stdio: "ignore",
    });
    this.serverProcess.unref();

    await waitForHttp(url, 15_000);
    this.rendererUrl = url;

    return url;
  }

  getTrustedOrigin(rendererUrl: string): string {
    return new URL(rendererUrl).origin;
  }

  getDesktopEntryUrl(rendererUrl: string): string {
    return `${this.getTrustedOrigin(rendererUrl)}${DESKTOP_ENTRY_PATH}`;
  }

  stop(): void {
    this.serverProcess?.kill();
    this.serverProcess = null;
    this.rendererUrl = null;
  }

  private resolveStandaloneServerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "warptalk-web", "server.js");
    }

    return path.resolve(
      app.getAppPath(),
      "..",
      "warptalk-web",
      ".next",
      "standalone",
      "server.js",
    );
  }

  private hasStandaloneServer(): boolean {
    return fs.existsSync(this.resolveStandaloneServerPath());
  }
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(`No available port found from ${startPort}`);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const ping = (): void => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.once("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(ping, 250);
      });
      request.setTimeout(1000, () => request.destroy());
    };

    ping();
  });
}

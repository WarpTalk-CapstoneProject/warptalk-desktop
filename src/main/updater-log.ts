/**
 * A file logger shaped like electron-updater's `Logger` (info / warn / error / debug).
 *
 * The updater works in the background by design, and its failures - offline, rate-limited, DNS -
 * are deliberately never shown to the user. That makes this file the only record of why an update
 * did or did not arrive: %APPDATA%\WarpTalk\logs\updater.log on Windows. No dependency, no rotation
 * beyond starting over once the file passes a size cap.
 */

import fs from "fs";
import path from "path";

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug(message: string): void;
}

export function createUpdaterLogger(
  file: string,
  { now = () => new Date(), maxBytes = 1024 * 1024 }: { now?: () => Date; maxBytes?: number } = {},
): UpdaterLogger {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > maxBytes) fs.truncateSync(file, 0);
  } catch {
    // A log that cannot be opened must never stop the app, or the updater, from running.
  }

  const write = (level: string, message: unknown): void => {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
    const line = `${now().toISOString()} [${level}] ${text}\n`;
    if (level === "error") console.error(`[updater] ${text}`);
    else console.log(`[updater] ${text}`);
    try {
      fs.appendFileSync(file, line);
    } catch {
      // Same as above: logging is best effort.
    }
  };

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    debug: (message) => write("debug", message),
  };
}

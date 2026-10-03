/**
 * The main process's own log: %APPDATA%\WarpTalk\logs\main.log on Windows.
 *
 * WHY
 *   A packaged app has no console. Everything main already said at the right moments - the Meet
 *   call state, why a capture stopped, a window that failed to load - went nowhere, and the only
 *   way to learn what the desktop saw during a broken bridge meeting was to run its sensor by hand
 *   beside it (2026-10-02). This file is that record. updater.log stays separate: it answers one
 *   question ("why did the update not arrive") and is read on its own.
 *
 * WHAT GOES IN
 *   main      every console.log / warn / error main already makes (teeConsole): no call site changes
 *   app       start (version, platform, where the web UI is served from), quit, crashes
 *   window    a page that loaded or failed to load, per window (main, popup)
 *   renderer  warnings and errors the web UI printed, per window - the hidden main window carries
 *             the meeting session, and its console is otherwise unreachable
 *   ipc       the calls the web UI makes that change something (IPC_LOGGED): what, how long, and
 *             whether it threw. Reads and per-frame channels are left out
 *   meet      what the sensors concluded, on change only: presence, call phase, Meet's mute button
 *
 * WHAT NEVER GOES IN
 *   Transcript or caption text, audio, tokens, or a URL's query string. `redact` is applied to
 *   every line, renderer lines included, so a careless console.log in the web UI cannot put a
 *   session token on disk. A Meet code stays: it is what ties a line to a call.
 *
 * SHAPE
 *   One line per event: `2026-10-02T10:21:27.431Z [info] [meet] call state {"phase":"in-call"}`.
 *   Greppable, and a consecutive repeat is counted instead of written again (a renderer error in a
 *   loop must not push everything else out). Size-capped: main.log rolls to main.1.log at
 *   `maxBytes`, and one older file is kept. No dependency.
 *
 * Best effort throughout: a log that cannot be written must never stop the app.
 */

import fs from "fs";
import path from "path";

export type MainLogLevel = "info" | "warn" | "error";

export interface MainLog {
  info(scope: string, message: string, data?: unknown): void;
  warn(scope: string, message: string, data?: unknown): void;
  error(scope: string, message: string, data?: unknown): void;
  /** Writes a pending "repeated N times" line. Call before quitting. */
  flush(): void;
  /** The file being written, for "Open logs folder" and tests. */
  readonly file: string;
}

/** Longest line kept. A stack trace fits; a dumped payload does not. */
export const MAX_LINE_CHARS = 2000;

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_PAIR =
  /((?:access|refresh|id|bridge|peer)?_?(?:token|secret|password|authorization|api[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi;
const URL_QUERY = /(\bhttps?:\/\/[^\s"'?#]+|\bwarptalk:\/\/[^\s"'?#]+)[?#][^\s"']*/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** Removes what must not reach the disk. See WHAT NEVER GOES IN. */
export function redact(text: string): string {
  return text
    .replace(JWT, "[jwt]")
    .replace(BEARER, "$1 [redacted]")
    .replace(SECRET_PAIR, "$1$2[redacted]")
    .replace(URL_QUERY, "$1?[redacted]")
    .replace(EMAIL, "[email]@$1");
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** console.log's arguments as one line: strings as they are, errors as stacks, the rest as JSON. */
export function formatArgs(args: readonly unknown[]): string {
  return args.map(stringify).join(" ");
}

export function formatLine(
  at: Date,
  level: MainLogLevel,
  scope: string,
  message: string,
  data?: unknown,
): string {
  const tail = data === undefined ? "" : ` ${stringify(data)}`;
  const body = redact(`${message}${tail}`).replace(/\r?\n/g, "\n    ");
  const clipped = body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}… [clipped]` : body;
  return `${at.toISOString()} [${level}] [${scope}] ${clipped}`;
}

export function createMainLog(
  file: string,
  {
    now = () => new Date(),
    maxBytes = 2 * 1024 * 1024,
  }: { now?: () => Date; maxBytes?: number } = {},
): MainLog {
  let size = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    // Best effort.
  }

  const roll = (): void => {
    try {
      const older = file.replace(/\.log$/, ".1.log");
      fs.rmSync(older, { force: true });
      fs.renameSync(file, older);
    } catch {
      // Could not roll (the file is held open elsewhere): start over rather than grow forever.
      try {
        fs.truncateSync(file, 0);
      } catch {
        // Best effort.
      }
    }
    size = 0;
  };

  const append = (line: string): void => {
    const bytes = Buffer.byteLength(line) + 1;
    if (size > 0 && size + bytes > maxBytes) roll();
    try {
      fs.appendFileSync(file, `${line}\n`);
      size += bytes;
    } catch {
      // Best effort.
    }
  };

  // A consecutive repeat is counted, not written: what repeats is the level, scope and text.
  let lastKey: string | null = null;
  let repeats = 0;
  const flush = (): void => {
    if (repeats > 0) append(`${now().toISOString()} [info] [log] last line repeated ${repeats} more time(s)`);
    repeats = 0;
  };

  const write = (level: MainLogLevel, scope: string, message: string, data?: unknown): void => {
    const at = now();
    const line = formatLine(at, level, scope, message, data);
    const key = line.slice(line.indexOf(" ") + 1);
    if (key === lastKey) {
      repeats++;
      return;
    }
    flush();
    lastKey = key;
    append(line);
  };

  return {
    info: (scope, message, data) => write("info", scope, message, data),
    warn: (scope, message, data) => write("warn", scope, message, data),
    error: (scope, message, data) => write("error", scope, message, data),
    flush,
    file,
  };
}

type ConsoleLike = Pick<Console, "log" | "info" | "warn" | "error">;

/**
 * Sends everything main prints to the log as well, under scope `main`. The console still gets it
 * (a dev run reads the terminal). Returns the undo, for tests.
 *
 * updater-log.ts also prints its lines to the console with an `[updater]` prefix; those already
 * have a file of their own and are left out here.
 */
export function teeConsole(log: MainLog, target: ConsoleLike = console): () => void {
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  const tee =
    (level: MainLogLevel, forward: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      forward.apply(target, args);
      const text = formatArgs(args);
      if (text.startsWith("[updater]")) return;
      log[level]("main", text);
    };
  target.log = tee("info", original.log);
  target.info = tee("info", original.info);
  target.warn = tee("warn", original.warn);
  target.error = tee("error", original.error);
  return () => Object.assign(target, original);
}

/**
 * The web UI's calls that change something on this machine. Reads (`app:version`, the `get-*`
 * handlers, status probes) and streams are left out: they are frequent and say nothing new.
 */
export const IPC_LOGGED: ReadonlySet<string> = new Set([
  "audio:start-capture",
  "audio:stop-capture",
  "auth:signed-in-state",
  "bridge:watch-meet-presence",
  "bridge:unwatch-meet-presence",
  "bridge:arm-meet-window-capture",
  "bridge:ensure-meet-captions",
  "bridge:meet-captions-stream",
  "bridge:install-virtual-audio",
  "bridge:align-hifi-format",
  "bridge:open-transcript-window",
  "bridge:activate-room",
  "bridge:close-transcript-window",
  "bridge:show-main-window",
]);

/** An IPC argument as it may be logged: scalars as they are, anything else by its shape only. */
function summarizeArg(arg: unknown): unknown {
  if (arg === null || arg === undefined) return arg ?? null;
  if (typeof arg === "string") return arg.length > 80 ? `${arg.slice(0, 80)}…` : arg;
  if (typeof arg === "number" || typeof arg === "boolean") return arg;
  if (Array.isArray(arg)) return `[array ${arg.length}]`;
  if (typeof arg === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(arg as Record<string, unknown>).slice(0, 12)) {
      out[key] =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
          ? summarizeArg(value)
          : `[${Array.isArray(value) ? "array" : typeof value}]`;
    }
    return out;
  }
  return `[${typeof arg}]`;
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
}

/**
 * Wraps `ipcMain.handle` so the handlers registered after it are logged: a logged channel
 * (IPC_LOGGED) gets one line per call with its arguments' summary and how long it took; ANY channel
 * gets an error line when its handler throws - the renderer sees a rejected promise, and until now
 * nothing else did. The handler's result and error pass through untouched.
 */
export function instrumentIpc(ipc: IpcMainLike, log: MainLog, clock: () => number = Date.now): void {
  const handle = ipc.handle.bind(ipc);
  ipc.handle = (channel, listener) => {
    handle(channel, async (event, ...args) => {
      const started = clock();
      try {
        const result = await listener(event, ...args);
        if (IPC_LOGGED.has(channel)) {
          log.info("ipc", channel, { args: args.map(summarizeArg), ms: clock() - started });
        }
        return result;
      } catch (error) {
        log.error("ipc", `${channel} threw`, {
          args: args.map(summarizeArg),
          ms: clock() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  };
}

/**
 * Whether a line the web UI printed is kept: warnings and errors only. Its info chatter is large,
 * and what main needs from the renderer is the moment something went wrong.
 *
 * Electron has reported the level both as a number (0 verbose, 1 info, 2 warning, 3 error) and, in
 * newer versions, as a word; both are read.
 */
export function rendererConsoleLevel(level: unknown): MainLogLevel | null {
  if (level === 3 || level === "error") return "error";
  if (level === 2 || level === "warning") return "warn";
  return null;
}

/** A page address as it may be logged: origin and path, never the query or fragment. */
export function loggableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return redact(url);
  }
}

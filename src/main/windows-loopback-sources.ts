/**
 * Turning an Electron desktopCapturer window source into the PID that per-process loopback needs.
 *
 * Windows has no Node API for "who owns this HWND", so the answer comes out of PowerShell. That
 * makes the cost of asking the thing to design around: every call is a process spawn, and it sits
 * on the path the user takes when they pick their Meet window. So nothing here runs synchronously
 * — the Electron main process runs the whole app's event loop, and blocking it to wait on a shell
 * is a frozen UI — and the common case never compiles any C#.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { DesktopCapturerSource } from "electron";

import type { WindowsLoopbackSource } from "../shared/types.ts";

const execFileAsync = promisify(execFile);

const MEETING_WINDOW_PATTERN = /\b(google meet|meet\.google\.com|chrome|msedge|firefox)\b/i;

/**
 * Generous enough to absorb PowerShell's own cold start, which on a machine that has not run it
 * yet is most of the wall clock here. Still bounded: a hung shell must not leave the capture
 * request waiting forever.
 */
const HANDLE_MAP_TIMEOUT_MS = 5000;
/** Longer, because this path pays a C# compile on top of the same cold start. */
const PINVOKE_TIMEOUT_MS = 10000;

/**
 * The PowerShell call, injectable so the tests can exercise both resolution paths on any
 * platform. Resolves to stdout, or null when the shell failed, timed out, or is not there.
 */
export type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string | null>;

export async function runPowerShellScript(
  script: string,
  timeoutMs: number,
): Promise<string | null> {
  // Fail closed off Windows rather than let execFile report a missing binary as a generic error:
  // there is no correct PID to report here, and a wrong one captures a stranger's audio.
  if (process.platform !== "win32") return null;

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Every failure here has the same answer — no PID — so a runner that rejects must not surface as
 * an unhandled rejection in the main process. Fail closed, uniformly.
 */
async function runOrNull(
  run: PowerShellRunner,
  script: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    return await run(script, timeoutMs);
  } catch {
    return null;
  }
}

export function parseDesktopSourceWindowHandle(sourceId: string): number | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  if (!match) return null;

  const handle = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

export function isLikelyMeetingWindow(name: string): boolean {
  return MEETING_WINDOW_PATTERN.test(name);
}

/**
 * Every process's main window, in one shell round trip.
 *
 * `Get-Process` already carries MainWindowHandle, so this needs no `Add-Type` and no C# compile —
 * the P/Invoke version of the same question costs 300-800 ms per call just to build the assembly.
 * Reading the whole table at once also means describing a list of windows is one spawn instead of
 * one per window.
 *
 * The catch is in the name: MainWindowHandle is the FIRST window of each process, so a Chrome with
 * three windows open appears here exactly once. A miss is expected, not an error — see
 * resolveWindowOwnerProcessId.
 */
export async function readMainWindowHandleMap(
  run: PowerShellRunner = runPowerShellScript,
): Promise<Map<number, number>> {
  const script =
    "Get-Process -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.MainWindowHandle -ne 0 } | " +
    'ForEach-Object { "$($_.MainWindowHandle.ToInt64())=$($_.Id)" }';

  const stdout = await runOrNull(run, script, HANDLE_MAP_TIMEOUT_MS);
  const handles = new Map<number, number>();
  if (!stdout) return handles;

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)=(\d+)$/.exec(line.trim());
    if (!match) continue;

    const handle = Number.parseInt(match[1], 10);
    const processId = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(handle) || handle <= 0) continue;
    if (!Number.isSafeInteger(processId) || processId <= 0) continue;
    handles.set(handle, processId);
  }
  return handles;
}

/**
 * The fallback for a window that is not its process's main one. This is the only path that needs
 * `GetWindowThreadProcessId`, and therefore the only one that pays for the runtime C# compile.
 */
async function resolveHandleViaPInvoke(
  handle: number,
  run: PowerShellRunner,
): Promise<number | null> {
  const script = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WindowProcess {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$processId = 0
[void][Win32WindowProcess]::GetWindowThreadProcessId([IntPtr]${handle}, [ref]$processId)
if ($processId -gt 0) { $processId }
`;

  const stdout = await runOrNull(run, script, PINVOKE_TIMEOUT_MS);
  if (!stdout) return null;

  const processId = Number.parseInt(stdout.trim(), 10);
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
}

/**
 * On Chrome the answer is the browser process, not a renderer: measured against a 37-process
 * Chrome, the top-level HWND belongs to the browser, so there is no parent chain to climb.
 */
export async function resolveWindowOwnerProcessId(
  sourceId: string,
  run: PowerShellRunner = runPowerShellScript,
): Promise<number | null> {
  const handle = parseDesktopSourceWindowHandle(sourceId);
  if (!handle) return null;

  const handles = await readMainWindowHandleMap(run);
  const mainWindowOwner = handles.get(handle);
  if (mainWindowOwner) return mainWindowOwner;

  return resolveHandleViaPInvoke(handle, run);
}

export function describeWindowsLoopbackSource(
  source: Pick<DesktopCapturerSource, "id" | "name">,
  ownerProcessId: number | null = null,
): WindowsLoopbackSource {
  return {
    id: source.id,
    name: source.name,
    windowHandle: parseDesktopSourceWindowHandle(source.id) ?? undefined,
    ownerProcessId: ownerProcessId ?? undefined,
    likelyMeetingWindow: isLikelyMeetingWindow(source.name),
  };
}

/**
 * Describes a whole picker list off a single handle table read.
 *
 * Deliberately no P/Invoke fallback per unmatched window: a list of twenty windows would mean
 * twenty compiles for a field that only labels the picker. The window the user actually chooses
 * gets the exact answer from resolveWindowOwnerProcessId before capture starts, and that is the
 * only place the PID is allowed to matter.
 */
export async function describeWindowsLoopbackSources(
  sources: ReadonlyArray<Pick<DesktopCapturerSource, "id" | "name">>,
  run: PowerShellRunner = runPowerShellScript,
): Promise<WindowsLoopbackSource[]> {
  const handles = await readMainWindowHandleMap(run);

  return sources.map((source) => {
    const handle = parseDesktopSourceWindowHandle(source.id);
    return describeWindowsLoopbackSource(source, (handle && handles.get(handle)) || null);
  });
}

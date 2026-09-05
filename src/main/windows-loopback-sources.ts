import { spawnSync } from "child_process";
import type { DesktopCapturerSource } from "electron";

import type { WindowsLoopbackSource } from "../shared/types.ts";

const MEETING_WINDOW_PATTERN = /\b(google meet|meet\.google\.com|chrome|msedge|firefox)\b/i;

export function parseDesktopSourceWindowHandle(sourceId: string): number | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  if (!match) return null;

  const handle = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

export function isLikelyMeetingWindow(name: string): boolean {
  return MEETING_WINDOW_PATTERN.test(name);
}

export function resolveWindowOwnerProcessId(sourceId: string): number | null {
  const handle = parseDesktopSourceWindowHandle(sourceId);
  if (!handle) return null;

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

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 2500,
    windowsHide: true,
  });

  if (result.status !== 0) return null;
  const processId = Number.parseInt(result.stdout.trim(), 10);
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
}

export function describeWindowsLoopbackSource(
  source: Pick<DesktopCapturerSource, "id" | "name">,
  ownerProcessId: number | null = resolveWindowOwnerProcessId(source.id),
): WindowsLoopbackSource {
  return {
    id: source.id,
    name: source.name,
    windowHandle: parseDesktopSourceWindowHandle(source.id) ?? undefined,
    ownerProcessId: ownerProcessId ?? undefined,
    likelyMeetingWindow: isLikelyMeetingWindow(source.name),
  };
}

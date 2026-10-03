/**
 * Reading the browser's own address bar, because the window title is not ours to trust.
 *
 * The old sensor matched window titles against a Meet pattern. Chrome names its OS window after
 * `document.title`, which the page writes — so any tab, an advert, a forgotten one, could put
 * "Google Meet" there and make the app believe a call was on screen. Matching harder cannot fix a
 * string authored by the party the check exists to guard against.
 *
 * A URL can't be written by the page it points at. UI Automation exposes it two ways, and both are
 * needed because Chrome presents a meeting in two shapes:
 *
 *   normal window   the Document node's ValuePattern holds the committed URL, scheme and path, so
 *                   the room code comes with it.
 *   picture-in-pic  there is no omnibox and the document reads `about:blank` — but the window
 *                   chrome shows the origin as a Text label, which is browser UI, not content.
 *                   Host only, so no room code, which is why the code is optional downstream.
 *                   Believed only when BOTH hold: the document is `about:blank`, and the label is
 *                   outside the Document subtree. The search used to cover every window and every
 *                   descendant, so any page whose text said "meet.google.com" read as a call.
 *                   On 2026-10-02 this label read did NOT recognise Chrome's PiP window for a
 *                   live call, so a second read now backs it: the window titled `Meet - <code>`
 *                   over `about:blank` with a call control inside. See meet-call-state.ts, which
 *                   also says what that read can and cannot be trusted for.
 *
 * WHY A LONG-LIVED HELPER AND NOT A SHELL PER POLL
 *   Measured on the target machine: spawning PowerShell per read costs 1.8-3.4 s once the UI
 *   Automation assemblies are loaded each time, which cannot fit a poll interval. The same reads
 *   inside one warm session are 9-55 ms. So the process is started once, asked a question per
 *   poll over stdin, and killed when the watcher disarms.
 *
 * WHY NOT PACKAGED AS A FILE
 *   The script is written to the OS temp directory at start. Shipping it as a resource would mean
 *   an electron-builder entry and a path that differs between dev and a package; this keeps it
 *   next to the code that owns it, in the same shape as the other PowerShell in this app.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  MEET_SURFACE_SCRIPT,
  parseMeetSurfaces,
  sightingFromScan,
  type MeetSurface,
} from "./meet-call-state.ts";

/** What one look at the machine found. Null means no Meet window, not "we could not look". */
export interface MeetSighting {
  /** Present only from a normal window; picture-in-picture exposes the host without the path. */
  meetCode: string | null;
  /**
   * The browser process that owns the window. Kept in main — the renderer never needs it.
   * Null from the macOS sensor, which asks the browser over Apple Events and never sees a window.
   */
  processId: number | null;
  /**
   * The top-level HWND the sighting was read from, as a decimal number. It is what Electron puts
   * in a window source id (`window:<HWND>:0`), so it lets main hand exactly this window to a
   * screen capture without asking the page which window to take (meet-window-capture.ts).
   * Not part of `MeetPresence`. The call state carries the handle of the window the call was read
   * from (`MeetCallState.windowHandle`), so the web app can re-arm the recording capture when a
   * Meet tab is dragged into another window; an HWND names a window, it does not grant access to
   * it. Absent from the macOS sensor and from older payloads.
   */
  windowHandle?: number | null;
  /** Which read produced this, for diagnosing a machine where one path works and the other does not. */
  via: "document" | "pip";
}

/**
 * One look, whole: the sighting, and every place Meet is showing with the buttons it shows there.
 * The buttons are what tell a call from the lobby and from the "you left" page, which share one
 * address. See meet-call-state.ts, which owns everything decided from them.
 */
export interface MeetScan {
  sighting: MeetSighting | null;
  surfaces: MeetSurface[];
}

/**
 * Answers one question per line on stdin, so the caller keeps the clock.
 *
 * The script self-polling would mean two independent intervals for one job. Here PowerShell is a
 * pure function of "look now", and `MeetPresenceWatcher` stays the only thing that decides when.
 */
export const SENSOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Button names come back in Meet's UI language; without this PowerShell 5.1 writes them as ANSI.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class MeetWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public delegate bool EnumProc(IntPtr h,IntPtr p);
}
'@

# Window class is not a browser filter: Electron apps use Chrome_WidgetWin_1 too, so on this
# machine Claude and Zalo both carry it. The owning executable is the only thing that separates a
# browser from something merely built on Chromium.
$BROWSERS = @('chrome','msedge','firefox','brave','opera','vivaldi')

# Meet's room code, as it appears in the path. The extension ecosystem matches the same shape with
# '*-*-*', and it is what keeps the landing page from counting as a meeting. No backticks in
# this script: it lives inside a template literal, where one would end the string early.
$CODE_PATH = '^/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})$'

$DOC_TYPE = [System.Windows.Automation.ControlType]::Document
$docCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $DOC_TYPE)
# The Meet origin label, exactly: a Text element whose whole name is the host.
$hostLabelCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'meet.google.com')))
# Raw view, so that no Document between a label and its window can be filtered out of the walk.
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

# Whether an element sits inside a Document, which makes it page content rather than browser UI.
function Test-InDocument($node, $root) {
  $parent = $walker.GetParent($node)
  while ($parent -ne $null) {
    if ($parent.Current.ControlType.Id -eq $DOC_TYPE.Id) { return $true }
    if ([System.Windows.Automation.Automation]::Compare($parent, $root)) { return $false }
    $parent = $walker.GetParent($parent)
  }
  return $false
}

function Get-BrowserWindows {
  $found = New-Object System.Collections.ArrayList
  $cb = [MeetWin+EnumProc]{ param($h,$p)
    if (-not [MeetWin]::IsWindowVisible($h)) { return $true }
    $tb = New-Object System.Text.StringBuilder 512
    [void][MeetWin]::GetWindowText($h,$tb,512)
    if ($tb.Length -eq 0) { return $true }
    $wpid = 0
    [void][MeetWin]::GetWindowThreadProcessId($h,[ref]$wpid)
    try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { return $true }
    if ($BROWSERS -notcontains $pn) { return $true }
    [void]$found.Add([pscustomobject]@{ H = $h; Pid = $wpid })
    return $true
  }
  [void][MeetWin]::EnumWindows($cb,[IntPtr]::Zero)
  return $found
}

function Read-Window($w) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($w.H)

  $doc = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
  if ($doc -eq $null) { return $null }

  $value = ''
  try { $value = $doc.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
  # Handed to Get-MeetSurface (meet-call-state.ts), so the button read does not find them twice.
  $script:doc = $doc
  $script:docValue = $value
  if ($value -match '^https?://') {
    try {
      $uri = [Uri]$value
      # Exact host equality, never a substring: 'evil.com/meet.google.com/abc-def-ghi' and
      # 'meet.google.com.evil.com' both contain the string and neither is Google.
      if ($uri.Host -eq 'meet.google.com' -and $uri.AbsolutePath -match $CODE_PATH) {
        return @{ meetCode = $Matches[1]; processId = $w.Pid; windowHandle = $w.H.ToInt64(); via = 'document' }
      }
    } catch {}
    # A page with a real address is a page, and that address was not Meet. Nothing else in this
    # window gets a say: the label search below would otherwise read the page's own text.
    return $null
  }

  # Picture-in-picture, and only picture-in-picture. Two gates, because each alone was spoofable:
  #   about:blank  a PiP window's document has no address of its own. A normal tab on any site
  #                does, and this search used to run on those too - so a page that merely MENTIONED
  #                meet.google.com was reported as a call (reproduced on Chrome 152).
  #   outside the Document  the origin label is browser chrome. A page can open its own blank PiP
  #                and write the host into it, but what it writes lands inside the Document; the
  #                chrome's label names the opener's real origin, which the page cannot choose.
  if ($value -ne 'about:blank') { return $null }
  $labels = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $hostLabelCond)
  for ($i = 0; $i -lt $labels.Count; $i++) {
    if (-not (Test-InDocument $labels.Item($i) $el)) {
      return @{ meetCode = $null; processId = $w.Pid; windowHandle = $w.H.ToInt64(); via = 'pip' }
    }
  }
  return $null
}

${MEET_SURFACE_SCRIPT}
# 'look' enumerates every browser window; 'state' re-reads only the windows Meet was last found in
# (meet-call-state.ts). Both answer in the same shape.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -ne 'look' -and $line -ne 'state') { continue }
  try {
    if ($line -eq 'state') { $scan = Read-MeetState } else { $scan = Read-MeetScan (Get-BrowserWindows) }
    Write-Output (ConvertTo-Json -Compress -Depth 6 $scan)
  } catch {
    Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message })
  }
}
`;

/** Long enough for a cold accessibility wake-up, short enough that a wedged shell is noticed. */
const READ_TIMEOUT_MS = 8000;

export class MeetUrlSensor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptPath: string | null = null;
  private buffer = "";
  private pending: ((line: string | null) => void) | null = null;
  /** Requests run one at a time: the helper is single-threaded and there is one `pending` slot. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by `stop`, so a request queued before it does not start the helper again after it. */
  private epoch = 0;

  /**
   * Starts the helper if it is not already running.
   *
   * Called from `read`, so a crash between polls is repaired by the next one rather than needing
   * its own supervisor. The watcher above already treats a failed read as "we could not look".
   */
  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    if (!this.scriptPath) {
      const dir = mkdtempSync(path.join(tmpdir(), "warptalk-meet-"));
      this.scriptPath = path.join(dir, "meet-url-sensor.ps1");
      writeFileSync(this.scriptPath, SENSOR_SCRIPT, "utf8");
    }

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
      { windowsHide: true },
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0 && this.pending) {
          const resolve = this.pending;
          this.pending = null;
          resolve(line);
        }
        index = this.buffer.indexOf("\n");
      }
    });

    // stderr is not fatal: PowerShell writes warnings there and the answer still arrives on stdout.
    child.stderr.resume();

    const fail = () => {
      this.child = null;
      this.buffer = "";
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(null);
      }
    };
    child.on("exit", fail);
    child.on("error", fail);

    this.child = child;
    return child;
  }

  /**
   * One look. Resolves to the sighting, or throws so the watcher keeps its last observation.
   *
   * Throwing rather than returning null for a failure is deliberate: null is a real answer that
   * means "no Meet on screen", and a helper that died must not be able to close a widget.
   */
  async read(): Promise<MeetSighting | null> {
    return (await this.scan("look")).sighting;
  }

  /**
   * One question to the helper, queued behind any other in flight.
   *
   * `look` is the presence poll's full enumeration. `state` is the call-state tracker's faster
   * read of the windows Meet was last found in (meet-call-state.ts). They share the helper, so
   * they must not share the single `pending` slot at the same moment - hence the queue.
   */
  scan(command: "look" | "state" = "look"): Promise<MeetScan> {
    const epoch = this.epoch;
    const run = () => {
      if (epoch !== this.epoch) throw new Error("The Meet URL sensor was stopped.");
      return this.ask(command);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async ask(command: "look" | "state"): Promise<MeetScan> {
    const child = this.ensureStarted();

    const line = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          resolve(null);
        }
      }, READ_TIMEOUT_MS);

      this.pending = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.stdin.write(`${command}\n`);
    });

    if (line === null) throw new Error("The Meet URL sensor did not answer.");

    const parsed = JSON.parse(line) as
      | { ok: true; sighting: MeetSighting | null; surfaces?: unknown }
      | { ok: false; error: string };
    if (!parsed.ok) throw new Error(parsed.error);
    const surfaces = parseMeetSurfaces(parsed.surfaces);
    // A surface that is in a call is a sighting even where the URL read found none: Chrome's
    // picture-in-picture window. See sightingFromScan for what this does and does not change.
    return { sighting: sightingFromScan(parsed.sighting ?? null, surfaces), surfaces };
  }

  stop(): void {
    this.epoch++;
    // Answered rather than dropped: an unanswered request would hold the queue for good.
    this.pending?.(null);
    this.pending = null;
    this.buffer = "";
    this.child?.kill();
    this.child = null;
  }
}

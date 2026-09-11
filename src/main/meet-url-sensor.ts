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

/** What one look at the machine found. Null means no Meet window, not "we could not look". */
export interface MeetSighting {
  /** Present only from a normal window; picture-in-picture exposes the host without the path. */
  meetCode: string | null;
  /** The browser process that owns the window. Kept in main — the renderer never needs it. */
  processId: number;
  /** Which read produced this, for diagnosing a machine where one path works and the other does not. */
  via: "document" | "pip";
}

/**
 * Answers one question per line on stdin, so the caller keeps the clock.
 *
 * The script self-polling would mean two independent intervals for one job. Here PowerShell is a
 * pure function of "look now", and `MeetPresenceWatcher` stays the only thing that decides when.
 */
export const SENSOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class MeetWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);
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
  if ($value -match '^https?://') {
    try {
      $uri = [Uri]$value
      # Exact host equality, never a substring: 'evil.com/meet.google.com/abc-def-ghi' and
      # 'meet.google.com.evil.com' both contain the string and neither is Google.
      if ($uri.Host -eq 'meet.google.com' -and $uri.AbsolutePath -match $CODE_PATH) {
        return @{ meetCode = $Matches[1]; processId = $w.Pid; via = 'document' }
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
      return @{ meetCode = $null; processId = $w.Pid; via = 'pip' }
    }
  }
  return $null
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -ne 'look') { continue }
  try {
    $hit = $null
    foreach ($w in (Get-BrowserWindows)) {
      $r = Read-Window $w
      # A normal window wins over a picture-in-picture one: it carries the room code.
      if ($r -ne $null) { $hit = $r; if ($r.via -eq 'document') { break } }
    }
    if ($hit -eq $null) {
      Write-Output '{"ok":true,"sighting":null}'
    } else {
      Write-Output (ConvertTo-Json -Compress @{ ok = $true; sighting = $hit })
    }
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
      child.stdin.write("look\n");
    });

    if (line === null) throw new Error("The Meet URL sensor did not answer.");

    const parsed = JSON.parse(line) as
      | { ok: true; sighting: MeetSighting | null }
      | { ok: false; error: string };
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.sighting;
  }

  stop(): void {
    this.pending = null;
    this.buffer = "";
    this.child?.kill();
    this.child = null;
  }
}

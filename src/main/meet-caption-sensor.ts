/**
 * The UI Automation helper behind meet-captions.ts: dumps the Meet tab's tree, and invokes one
 * button when TypeScript names it. It decides nothing - every judgement (which button is Meet's
 * CC button, where the captions are, who spoke) is made in meet-captions.ts against this dump.
 *
 * Same shape as meet-url-sensor.ts and for the same reasons: one long-lived PowerShell answering
 * one command per stdin line (a shell per read costs seconds), the script written to the temp
 * directory at start. A sibling process rather than a mode of the URL sensor, so a caption read
 * (up to a few hundred ms) never delays a presence poll.
 *
 * READING
 *   Only the ACTIVE tab of a Chrome window is exposed, so "the Meet tab" means a browser window
 *   whose active tab's Document URL is https://meet.google.com/<code> - exact host, exact path,
 *   the same gates as the URL sensor. The Document found is cached and its URL re-checked on
 *   every read. One CacheRequest (control view, subtree) fetches the whole tree in a single
 *   cross-process call; it is emitted flat (`p` = parent index). A first read may come back
 *   nearly empty while Chrome wakes its accessibility tree; the next read is complete.
 *
 * INVOKING
 *   `invoke` re-reads the tree, requires exactly one Button whose name, class and parent's name
 *   are byte-equal to what TypeScript identified, re-reads that button's live name, and only then
 *   calls InvokePattern. Invoke is UIA's default action: no focus change, no keystroke.
 *
 * ENCODING
 *   PowerShell 5.1 reads a BOM-less script as ANSI, so the script is pure ASCII (a test holds
 *   that); non-ASCII arguments (Vietnamese labels) travel as base64 UTF-8, and stdout is switched
 *   to UTF-8 so names come back intact.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  MEET_CODE,
  treeFromFlat,
  type CaptionButtonTarget,
  type FlatUiaNode,
  type MeetCaptionSensorLike,
  type MeetTabSnapshot,
} from "./meet-captions.ts";

/** Commands: `snap <id> <code>` and `invoke <id> <code> <b64 name> <b64 class> <b64 group>`. */
export const CAPTION_SENSOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class MeetCapWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  public delegate bool EnumProc(IntPtr h,IntPtr p);
}
'@

$BROWSERS = @('chrome','msedge','brave','opera','vivaldi')
$CODE = '^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$'
$A = [System.Windows.Automation.AutomationElement]
$BUTTON = [System.Windows.Automation.ControlType]::Button
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$script:doc = $null
$script:docWin = [IntPtr]::Zero

function Get-BrowserWindows {
  $found = New-Object System.Collections.ArrayList
  $cb = [MeetCapWin+EnumProc]{ param($h,$p)
    if (-not [MeetCapWin]::IsWindowVisible($h)) { return $true }
    $wpid = 0
    [void][MeetCapWin]::GetWindowThreadProcessId($h,[ref]$wpid)
    try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { return $true }
    if ($BROWSERS -contains $pn) { [void]$found.Add($h) }
    return $true
  }
  [void][MeetCapWin]::EnumWindows($cb,[IntPtr]::Zero)
  return $found
}

# The room code of a Document, or null. Exact host and path, never a substring.
function Get-DocCode($d) {
  $v = ''
  try { $v = $d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null }
  if ($v -notmatch '^https://') { return $null }
  try { $u = [Uri]$v } catch { return $null }
  if ($u.Host -ne 'meet.google.com') { return $null }
  if ($u.AbsolutePath -cmatch '^/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})$') { return $Matches[1] }
  return $null
}

function Find-MeetDoc($code) {
  if ($script:doc -ne $null) {
    $c = $null
    try { $c = Get-DocCode $script:doc } catch {}
    if ($c -ceq $code) { return $script:doc }
    $script:doc = $null
  }
  foreach ($h in (Get-BrowserWindows)) {
    try {
      $d = $A::FromHandle($h).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
      if ($d -ne $null -and (Get-DocCode $d) -ceq $code) { $script:doc = $d; $script:docWin = $h; return $d }
    } catch {}
  }
  return $null
}

# A hint only, never a source: Meet's auto picture-in-picture window is titled 'Meet - <code>' and
# exposes no captions, so its presence says "the Meet tab exists but is not the active tab".
function Test-PipWindow($code) {
  foreach ($h in (Get-BrowserWindows)) {
    $tb = New-Object System.Text.StringBuilder 256
    [void][MeetCapWin]::GetWindowText($h,$tb,256)
    if ($tb.ToString() -ceq ('Meet - ' + $code)) { return $true }
  }
  return $false
}

function New-Cache($full) {
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
  $cr.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $cr.Add($A::ControlTypeProperty)
  $cr.Add($A::NameProperty)
  $cr.Add($A::ClassNameProperty)
  $cr.Add($A::AutomationIdProperty)
  $cr.Add($A::IsOffscreenProperty)
  $cr.Add($A::IsInvokePatternAvailableProperty)
  if (-not $full) { $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None }
  return $cr
}

function Add-Node($e, $parent, $list) {
  $idx = $list.Count
  $inv = $false
  try { $inv = [bool]$e.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty) } catch {}
  [void]$list.Add([ordered]@{
    p = $parent
    t = ($e.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    n = [string]$e.Cached.Name
    c = [string]$e.Cached.ClassName
    a = [string]$e.Cached.AutomationId
    o = [bool]$e.Cached.IsOffscreen
    i = $inv
  })
  $kids = $e.CachedChildren
  if ($null -eq $kids) { return }
  for ($k = 0; $k -lt $kids.Count; $k++) { Add-Node $kids[$k] $idx $list }
}

function Find-Target($e, $parentName, $name, $cls, $group, $hits) {
  if ($e.Cached.ControlType.Id -eq $BUTTON.Id -and ([string]$e.Cached.Name) -ceq $name -and ([string]$e.Cached.ClassName) -ceq $cls -and $parentName -ceq $group) {
    [void]$hits.Add($e)
  }
  $kids = $e.CachedChildren
  if ($null -eq $kids) { return }
  $me = [string]$e.Cached.Name
  for ($k = 0; $k -lt $kids.Count; $k++) { Find-Target $kids[$k] $me $name $cls $group $hits }
}

function From-B64($s) {
  if ($s -eq '-') { return '' }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

function Do-Snap($id, $code) {
  $d = Find-MeetDoc $code
  if ($d -eq $null) { return @{ id = $id; ok = $true; found = $false; pip = (Test-PipWindow $code) } }
  $min = [bool][MeetCapWin]::IsIconic($script:docWin)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $root = $d.GetUpdatedCache((New-Cache $false))
  $list = New-Object System.Collections.ArrayList
  Add-Node $root (-1) $list
  return @{ id = $id; ok = $true; found = $true; minimized = $min; ms = $sw.ElapsedMilliseconds; nodes = $list }
}

function Do-Invoke($id, $code, $name, $cls, $group) {
  $d = Find-MeetDoc $code
  if ($d -eq $null) { return @{ id = $id; ok = $true; invoked = $false; reason = 'meet-tab-not-found' } }
  $root = $d.GetUpdatedCache((New-Cache $true))
  $hits = New-Object System.Collections.ArrayList
  Find-Target $root '' $name $cls $group $hits
  if ($hits.Count -eq 0) { return @{ id = $id; ok = $true; invoked = $false; reason = 'target-not-found' } }
  if ($hits.Count -gt 1) { return @{ id = $id; ok = $true; invoked = $false; reason = 'target-not-unique' } }
  $t = $hits[0]
  # The live label, not the cached one: if it no longer says what TypeScript judged, do nothing.
  if (([string]$t.Current.Name) -cne $name) { return @{ id = $id; ok = $true; invoked = $false; reason = 'label-changed' } }
  $t.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  return @{ id = $id; ok = $true; invoked = $true }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  $id = $parts[1]
  try {
    if ($parts.Count -ge 3 -and -not ($parts[2] -cmatch $CODE)) { $r = @{ id = $id; ok = $false; error = 'bad-meet-code' } }
    elseif ($parts[0] -eq 'snap' -and $parts.Count -eq 3) { $r = Do-Snap $id $parts[2] }
    elseif ($parts[0] -eq 'invoke' -and $parts.Count -eq 6) { $r = Do-Invoke $id $parts[2] (From-B64 $parts[3]) (From-B64 $parts[4]) (From-B64 $parts[5]) }
    else { $r = @{ id = $id; ok = $false; error = 'bad-command' } }
  } catch {
    $script:doc = $null
    $r = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  Write-Output (ConvertTo-Json -Compress -Depth 5 $r)
}
`;

/** Long enough for a cold accessibility wake-up, short enough that a wedged shell is noticed. */
const SNAP_TIMEOUT_MS = 8000;
const INVOKE_TIMEOUT_MS = 6000;
/**
 * Added to the first request of a fresh helper. Measured on the target machine: 5.5 s from spawn
 * to the first answer (PowerShell start, Add-Type compile, window scan, accessibility wake-up);
 * later reads answer in 100-250 ms.
 */
const STARTUP_ALLOWANCE_MS = 15000;

function b64(value: string): string {
  return value.length === 0 ? "-" : Buffer.from(value, "utf8").toString("base64");
}

type Reply =
  | { id: string; ok: true; found?: boolean; pip?: boolean; minimized?: boolean; ms?: number; nodes?: FlatUiaNode[] | FlatUiaNode; invoked?: boolean; reason?: string }
  | { id: string; ok: false; error: string };

export class MeetCaptionSensor implements MeetCaptionSensorLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptPath: string | null = null;
  private buffer = "";
  private nextId = 1;
  private waiting = new Map<string, (line: Reply | null) => void>();
  /** Requests run one at a time; the helper is single-threaded and answers in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** True until the current helper has answered once. */
  private cold = true;

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    if (!this.scriptPath) {
      const dir = mkdtempSync(path.join(tmpdir(), "warptalk-meetcc-"));
      this.scriptPath = path.join(dir, "meet-caption-sensor.ps1");
      writeFileSync(this.scriptPath, CAPTION_SENSOR_SCRIPT, "utf8");
    }
    this.cold = true;
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
        if (line.length > 0) {
          this.cold = false;
          this.answer(line);
        }
        index = this.buffer.indexOf("\n");
      }
    });
    child.stderr.resume();
    const fail = () => {
      if (this.child === child) this.child = null;
      this.buffer = "";
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    };
    child.on("exit", fail);
    child.on("error", fail);
    this.child = child;
    return child;
  }

  private answer(line: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      return;
    }
    // A late answer to a request that already timed out carries an id nobody waits for.
    const resolve = this.waiting.get(String(reply.id));
    if (!resolve) return;
    this.waiting.delete(String(reply.id));
    resolve(reply);
  }

  private request(command: string, args: string[], timeoutMs: number): Promise<Reply | null> {
    const run = () =>
      new Promise<Reply | null>((resolve) => {
        const child = this.ensureStarted();
        const id = String(this.nextId++);
        const timer = setTimeout(() => {
          if (this.waiting.delete(id)) resolve(null);
        }, timeoutMs + (this.cold ? STARTUP_ALLOWANCE_MS : 0));
        this.waiting.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        child.stdin.write(`${[command, id, ...args].join(" ")}\n`);
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async snapshot(meetCode: string): Promise<MeetTabSnapshot> {
    if (!MEET_CODE.test(meetCode)) return { found: false };
    const reply = await this.request("snap", [meetCode], SNAP_TIMEOUT_MS);
    if (reply === null) throw new Error("The Meet caption sensor did not answer.");
    if (!reply.ok) throw new Error(reply.error);
    if (!reply.found) return { found: false, pipWindow: Boolean(reply.pip) };
    const flat = reply.nodes ? (Array.isArray(reply.nodes) ? reply.nodes : [reply.nodes]) : [];
    const root = treeFromFlat(flat);
    if (!root) return { found: false };
    return { found: true, root, readMs: reply.ms, minimized: Boolean(reply.minimized) };
  }

  async invoke(meetCode: string, target: CaptionButtonTarget): Promise<{ invoked: boolean; reason?: string }> {
    if (!MEET_CODE.test(meetCode)) return { invoked: false, reason: "invalid-meet-code" };
    const reply = await this.request(
      "invoke",
      [meetCode, b64(target.name), b64(target.className), b64(target.groupName)],
      INVOKE_TIMEOUT_MS,
    );
    if (reply === null) return { invoked: false, reason: "no-answer" };
    if (!reply.ok) return { invoked: false, reason: reply.error };
    return { invoked: Boolean(reply.invoked), reason: reply.reason };
  }

  stop(): void {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    this.buffer = "";
    this.child?.kill();
    this.child = null;
  }
}

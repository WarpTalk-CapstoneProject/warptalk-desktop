/**
 * "The Meet tab was closed" - told apart from "Meet is merely out of sight".
 *
 * WHY THIS EXISTS
 *   Prod, 2026-10-03 (desktop 0.5.0): the user closed the Meet tab. Every later read found no Meet
 *   surface at all, which meet-call-state.ts rightly calls `unknown / no-meet-surface` - a Meet tab
 *   the user merely switched away from looks exactly the same through the Document read, because UI
 *   Automation only exposes a window's ACTIVE tab. The web app ignores `unknown` by design, so the
 *   WarpTalk room was never ended. PO decision: positive evidence that the Meet TAB is gone counts
 *   as the meeting ending for this user, through the web app's existing 30 s countdown - so it is
 *   reported as phase `left`, with a reason of its own. Losing sight of Meet (tab switch, minimise,
 *   PiP, F11) must never count.
 *
 * WHAT THE EVIDENCE IS (measured, read-only UIA, 2026-10-03)
 *   The tab strip is browser chrome: `TabItem < Tab:TabContainerImpl < Pane:TabStrip < ... <
 *   BrowserRootView < Window` in Chrome, `Tab:EdgeTabStripRegionView` in Edge - outside every
 *   Document, so a page cannot write into it. A page CAN draw its own tablist (Google's app switcher
 *   in Docs is a `Tab` with `TabItem`s) but that one sits inside a Document and is refused.
 *   A TabItem exposes only its Name (= the page title, written by the page: NOT an identity - a
 *   GitHub tab was titled "... Google Meet ...") and `SelectionItemPattern.IsSelected`, live, for
 *   background tabs too. Its RuntimeId (`42.<HWND>.4.0.0.<n>`) is what identifies it:
 *     stable  over 8 s with the tab index shifting (user's Chrome); across a selection change, a
 *             reload, and another tab closing (throwaway Chrome 2026-10-03, and Edge for the
 *             selection change and tab close);
 *     changes when the tab is dragged to another window (the HWND is in it) - handled below by
 *             the full scan finding Meet in the new window.
 *   Not readable: Chrome started fullscreen (no Tab control at all), and Edge MINIMISED - its strip
 *   is there but holds no TabItem, which would read as "every tab closed". Hence: a minimised
 *   window, a missing strip and an empty strip are all "cannot tell", never "closed".
 *
 * THE RULES (`judgeMeetTab`, `judgeMeetTabs`)
 *   A tab is remembered once a Meet tab surface for code X has come back twice in a row with the
 *   same selected TabItem in that window (one read could catch the user mid tab switch, between the
 *   Document read and the tab strip read). When a full scan then finds no Meet surface at all (no
 *   tab, no picture-in-picture window - a PiP window is `in-call` and never gets here), each
 *   remembered tab of X is looked up again by RuntimeId in its window:
 *     browser process gone                      -> gone: browser-gone
 *     window gone                               -> gone: window-closed
 *     window minimised / no strip / empty strip -> cannot tell (unknown)
 *     TabItem there, not selected               -> still open in the background (unknown)
 *     TabItem there, selected, address http(s)
 *       and not X                               -> gone: tab-navigated
 *     TabItem there, selected, otherwise        -> cannot tell (unknown)
 *     TabItem missing                           -> gone: tab-closed (the full scan found X in no
 *                                                  other window, so it was not dragged away)
 *   `left` only when EVERY remembered tab of X is gone. Anything else keeps `unknown` - "LEFT NEEDS
 *   EVIDENCE" is meet-call-state.ts's principle and this module keeps it.
 *
 * SHAPE
 *   As in meet-call-state.ts: PowerShell only reads (MEET_TAB_SCRIPT, spliced into the URL sensor's
 *   helper), every judgement is a pure function here. Debounce and the "a later unknown must not
 *   undo it" rule live in the tracker (MeetCallStateTracker).
 */

import { MEET_CODE } from "./meet-captions.ts";
import { isWindowHandle } from "./window-handle.ts";
import type { MeetCallTabGoneReason } from "../shared/types.ts";

/** The reasons a `left` from this module carries (`MeetCallState.reason`, shared/types.ts). */
export type MeetTabGoneReason = MeetCallTabGoneReason;

/** The reasons an `unknown` from this module carries: nothing proves the tab is gone. */
export type MeetTabUnsureReason =
  | "tab-in-background"
  | "window-minimized"
  | "tab-strip-unreadable"
  | "tab-still-meet"
  | "document-unreadable"
  | "tab-check-missing"
  | "tab-check-partial";

export const MEET_TAB_GONE_REASONS: readonly MeetTabGoneReason[] = [
  "tab-closed",
  "tab-navigated",
  "window-closed",
  "browser-gone",
];

export function isMeetTabGoneReason(reason: string): reason is MeetTabGoneReason {
  return (MEET_TAB_GONE_REASONS as readonly string[]).includes(reason);
}

/** The selected TabItem of the window a Meet tab surface was read from (helper: `surface.tab`). */
export interface MeetTabRef {
  runtimeId: string;
  title: string;
}

/** A Meet tab, as remembered. */
export interface MeetTabIdentity {
  meetCode: string;
  windowHandle: number;
  processId: number;
  runtimeId: string;
  /** For main.log only: page-written, never an identity. */
  lastTitle: string;
  /** Consecutive reads it was seen in; remembered (confirmed) from 2. */
  seen: number;
  /** Date.now() of the last read that saw it. */
  atMs: number;
}

/** What the helper found when it looked a remembered tab up again (helper: `tabChecks`). */
export interface MeetTabCheck {
  meetCode: string;
  windowHandle: number;
  runtimeId: string;
  processAlive: boolean;
  windowAlive: boolean;
  minimized: boolean;
  /** "ok": the strip was read and held tabs; "unreadable": no strip, or an empty one. */
  strip: "ok" | "unreadable";
  present: boolean;
  selected: boolean;
  /** The window's active Document: an http(s) address, or nothing readable. */
  active: "url" | "none";
  /** The Meet code of that address, when it is a Meet meeting address. */
  activeCode: string | null;
}

/** The entry the helper is asked to check: `<code>,<hwnd>,<pid>,<runtimeId>`. */
export interface MeetTabWatchEntry {
  meetCode: string;
  windowHandle: number;
  processId: number;
  runtimeId: string;
}

const RUNTIME_ID = /^-?\d+(\.-?\d+){1,15}$/;
const TITLE_MAX = 120;

function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}...` : flat;
}

/** The helper's `surface.tab`, defensively. */
export function parseMeetTabRef(raw: unknown): MeetTabRef | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const rid = item.rid;
  if (typeof rid !== "string" || !RUNTIME_ID.test(rid)) return null;
  return { runtimeId: rid, title: typeof item.title === "string" ? clipTitle(item.title) : "" };
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  // PowerShell's ConvertTo-Json collapses a one-element array into the element itself.
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The helper's `tabChecks`, defensively: anything malformed is dropped, never trusted. */
export function parseMeetTabChecks(raw: unknown): MeetTabCheck[] {
  const out: MeetTabCheck[] = [];
  for (const item of asArray(raw as Record<string, unknown> | Record<string, unknown>[] | null)) {
    if (!item || typeof item !== "object") continue;
    const { code, hwnd, rid } = item;
    if (typeof code !== "string" || !MEET_CODE.test(code)) continue;
    if (!isWindowHandle(hwnd)) continue;
    if (typeof rid !== "string" || !RUNTIME_ID.test(rid)) continue;
    // Every flag must be a real boolean: a missing one is not "false", it is a broken answer.
    const flags = ["processAlive", "windowAlive", "minimized", "present", "selected"] as const;
    if (flags.some((f) => typeof item[f] !== "boolean")) continue;
    if (item.strip !== "ok" && item.strip !== "unreadable") continue;
    if (item.active !== "url" && item.active !== "none") continue;
    const activeCode = typeof item.activeCode === "string" && MEET_CODE.test(item.activeCode) ? item.activeCode : null;
    out.push({
      meetCode: code,
      windowHandle: hwnd,
      runtimeId: rid,
      processAlive: item.processAlive as boolean,
      windowAlive: item.windowAlive as boolean,
      minimized: item.minimized as boolean,
      strip: item.strip,
      present: item.present as boolean,
      selected: item.selected as boolean,
      active: item.active,
      activeCode,
    });
  }
  return out;
}

export type MeetTabJudgement =
  | { gone: true; reason: MeetTabGoneReason }
  | { gone: false; reason: MeetTabUnsureReason };

/** One remembered tab against what the helper found for it. See the table at the top. */
export function judgeMeetTab(identity: MeetTabIdentity, check: MeetTabCheck | undefined): MeetTabJudgement {
  if (!check) return { gone: false, reason: "tab-check-missing" };
  if (!check.processAlive) return { gone: true, reason: "browser-gone" };
  if (!check.windowAlive) return { gone: true, reason: "window-closed" };
  if (check.minimized) return { gone: false, reason: "window-minimized" };
  if (check.strip !== "ok") return { gone: false, reason: "tab-strip-unreadable" };
  if (check.present && !check.selected) return { gone: false, reason: "tab-in-background" };
  if (check.present) {
    if (check.activeCode === identity.meetCode) return { gone: false, reason: "tab-still-meet" };
    if (check.active === "url") return { gone: true, reason: "tab-navigated" };
    return { gone: false, reason: "document-unreadable" };
  }
  return { gone: true, reason: "tab-closed" };
}

/** What every remembered tab of one meeting adds up to, for a read that found no Meet surface. */
export interface MeetTabVerdict {
  meetCode: string;
  left: boolean;
  reason: MeetTabGoneReason | MeetTabUnsureReason;
  /** Per tab, for main.log: `<runtimeId>:<reason>`. */
  tabs: string[];
}

/** An unsure reason that says the tab is still there outranks one that only says "cannot tell". */
const UNSURE_RANK: Record<MeetTabUnsureReason, number> = {
  "tab-in-background": 6,
  "tab-still-meet": 5,
  "window-minimized": 4,
  "tab-strip-unreadable": 3,
  "document-unreadable": 2,
  "tab-check-missing": 1,
  "tab-check-partial": 0,
};

/**
 * Null when nothing is remembered for the meeting (no opinion: the read stays `no-meet-surface`).
 * `full` is whether the read that found no surface enumerated every browser window; anything less
 * cannot rule out the tab having been dragged to another window, so it decides nothing.
 */
export function judgeMeetTabs(
  identities: MeetTabIdentity[],
  checks: MeetTabCheck[],
  full: boolean,
): MeetTabVerdict | null {
  if (identities.length === 0) return null;
  const meetCode = identities[0].meetCode;
  if (!full) return { meetCode, left: false, reason: "tab-check-partial", tabs: [] };
  const judged = identities.map((identity) => ({
    identity,
    verdict: judgeMeetTab(
      identity,
      checks.find((c) => c.runtimeId === identity.runtimeId && c.windowHandle === identity.windowHandle),
    ),
  }));
  const tabs = judged.map((j) => `${j.identity.runtimeId}:${j.verdict.reason}`);
  const unsure = judged.filter((j) => !j.verdict.gone);
  if (unsure.length > 0) {
    const best = unsure.reduce((a, b) =>
      UNSURE_RANK[b.verdict.reason as MeetTabUnsureReason] > UNSURE_RANK[a.verdict.reason as MeetTabUnsureReason] ? b : a,
    );
    return { meetCode, left: false, reason: best.verdict.reason, tabs };
  }
  // All gone: the reason of the tab seen last is the one that ended the call.
  const latest = judged.reduce((a, b) => (b.identity.atMs > a.identity.atMs ? b : a));
  return { meetCode, left: true, reason: latest.verdict.reason, tabs };
}

/** One Meet tab surface's identity material, as meet-call-state.ts hands it over. */
export interface MeetTabSighting {
  meetCode: string;
  windowHandle: number | null | undefined;
  processId: number | null;
  tab: MeetTabRef | null | undefined;
}

/**
 * The remembered Meet tabs. Fed every read's tab surfaces (`record`); asked which tabs to have the
 * helper check (`watchList`) and what a read without any Meet surface means (`judge`).
 */
export class MeetTabWatch {
  private identities = new Map<string, MeetTabIdentity>();

  /** Every identity, confirmed or not. Tests and logs. */
  get all(): MeetTabIdentity[] {
    return [...this.identities.values()];
  }

  /** Confirmed identities of one meeting. */
  confirmed(meetCode: string | null): MeetTabIdentity[] {
    if (!meetCode) return [];
    return this.all.filter((i) => i.meetCode === meetCode && i.seen >= 2);
  }

  /**
   * One read's tab surfaces. Returns the identities that became confirmed with this read, for
   * main.log. A read without tab surfaces (PiP only, nothing at all, a failed read) changes nothing:
   * it is exactly the stretch the remembered tabs are for.
   */
  record(sightings: MeetTabSighting[], atMs: number): MeetTabIdentity[] {
    const usable = sightings.filter(
      (s) => s.tab && isWindowHandle(s.windowHandle) && typeof s.processId === "number" && s.processId > 0,
    );
    if (usable.length === 0) return [];
    const seenNow = new Set<string>();
    const confirmedNow: MeetTabIdentity[] = [];
    for (const s of usable) {
      const tab = s.tab as MeetTabRef;
      const prior = this.identities.get(tab.runtimeId);
      const seen = prior && prior.meetCode === s.meetCode && prior.windowHandle === s.windowHandle ? prior.seen + 1 : 1;
      const next: MeetTabIdentity = {
        meetCode: s.meetCode,
        windowHandle: s.windowHandle as number,
        processId: s.processId as number,
        runtimeId: tab.runtimeId,
        lastTitle: tab.title,
        seen,
        atMs,
      };
      this.identities.set(tab.runtimeId, next);
      seenNow.add(tab.runtimeId);
      if (seen === 2) confirmedNow.push(next);
    }
    const codesNow = new Set(usable.map((s) => s.meetCode));
    for (const [rid, identity] of this.identities) {
      if (seenNow.has(rid)) continue;
      // Not seen twice in a row: it was one read, possibly caught mid tab switch. Forgotten.
      if (identity.seen < 2) this.identities.delete(rid);
      // Another meeting is on screen in a tab now: the old one's tabs say nothing about it.
      else if (!codesNow.has(identity.meetCode)) this.identities.delete(rid);
    }
    return confirmedNow;
  }

  /** What the helper should look up again for this meeting. */
  watchList(meetCode: string | null): MeetTabWatchEntry[] {
    return this.confirmed(meetCode).map(({ meetCode: code, windowHandle, processId, runtimeId }) => ({
      meetCode: code,
      windowHandle,
      processId,
      runtimeId,
    }));
  }

  judge(meetCode: string | null, checks: MeetTabCheck[], full: boolean): MeetTabVerdict | null {
    return judgeMeetTabs(this.confirmed(meetCode), checks, full);
  }

  /** The meeting is over for these tabs (a `left` was committed), or nobody is watching any more. */
  forget(meetCode?: string): void {
    if (meetCode === undefined) {
      this.identities.clear();
      return;
    }
    for (const [rid, identity] of this.identities) {
      if (identity.meetCode === meetCode) this.identities.delete(rid);
    }
  }
}

/** The helper's command suffix for a watch list: `<code>,<hwnd>,<pid>,<rid>;...` (ASCII only). */
export function formatMeetTabWatch(entries: MeetTabWatchEntry[]): string {
  return entries
    .filter(
      (e) =>
        MEET_CODE.test(e.meetCode) &&
        isWindowHandle(e.windowHandle) &&
        Number.isSafeInteger(e.processId) &&
        e.processId > 0 &&
        RUNTIME_ID.test(e.runtimeId),
    )
    .map((e) => `${e.meetCode},${e.windowHandle},${e.processId},${e.runtimeId}`)
    .join(";");
}

/**
 * Spliced into the URL sensor's script after MEET_SURFACE_SCRIPT: uses its `MeetWin` class,
 * `$BROWSERS`, `$CODE_PATH`, `$docCond` and `Test-InDocument`. Pure ASCII, no backticks (template
 * literal). Reads only: nothing is selected, invoked, focused or typed.
 *
 * Cost (measured 2026-10-03): finding the strip 17-55 ms once per window (cached after), listing
 * its TabItems 4-6 ms. The selected tab is read once per Meet tab surface per read; the full
 * check runs only for remembered tabs of a meeting that no surface showed.
 */
export const MEET_TAB_SCRIPT = String.raw`
$tabCtlCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Tab)
$tabItemCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$TAB_RID = '^-?[0-9]+(\.-?[0-9]+){1,15}$'
$TAB_WATCH = '^([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}),([0-9]{1,19}),([0-9]{1,10}),(-?[0-9]+(\.-?[0-9]+){1,15})$'
# The tab strip element per window handle: finding it walks the whole window (17-55 ms), listing
# it does not (4-6 ms).
$script:tabStrips = @{}

# The window's tab strip: the first Tab control OUTSIDE every Document. A page can draw its own
# tablist, but it lands inside its Document. Null when the window has none (fullscreen, an app
# window, a browser whose tabs are not exposed this way).
function Find-TabStrip($h, $el) {
  if ($el -eq $null) { $el = [System.Windows.Automation.AutomationElement]::FromHandle($h) }
  $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCtlCond)
  for ($i = 0; $i -lt $all.Count; $i++) {
    $t = $all.Item($i)
    if (-not (Test-InDocument $t $el)) { return $t }
  }
  return $null
}

function Get-TabItems($strip) {
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cr.Add([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
  $cr.Add([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
  $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
  $scope = $cr.Activate()
  try { $items = $strip.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabItemCond) }
  finally { $scope.Dispose() }
  $list = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $items.Count; $i++) {
    $t = $items.Item($i)
    $rid = ''
    try { $rid = (@($t.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)) -join '.') } catch { $rid = '' }
    $sel = $false
    try { $sel = ($t.GetCachedPropertyValue([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty) -eq $true) } catch { $sel = $false }
    if ($rid -match $TAB_RID) { [void]$list.Add(@{ rid = $rid; sel = [bool]$sel; title = [string]$t.Cached.Name }) }
  }
  return ,$list
}

# Every tab of a window's strip, or null when it cannot be read. A minimised window is not read:
# Edge empties its strip then (measured), which would look like every tab closed. An empty strip
# is null too - a browser window always has a tab.
function Read-TabStrip($h, $el) {
  if ([MeetWin]::IsIconic($h)) { return $null }
  $key = $h.ToInt64()
  $strip = $script:tabStrips[$key]
  $items = $null
  if ($strip -ne $null) {
    try { $items = Get-TabItems $strip } catch { $items = $null; $script:tabStrips.Remove($key) }
  }
  if ($null -eq $items -or $items.Count -eq 0) {
    $strip = Find-TabStrip $h $el
    if ($strip -eq $null) { $script:tabStrips.Remove($key); return $null }
    $script:tabStrips[$key] = $strip
    $items = Get-TabItems $strip
  }
  if ($items.Count -eq 0) { return $null }
  return ,$items
}

# The selected tab of the window a Meet tab surface was just read from: its RuntimeId and title.
# Null unless exactly one tab is selected.
function Get-SelectedTab($w, $el) {
  $items = Read-TabStrip $w.H $el
  if ($null -eq $items) { return $null }
  $sel = @($items | Where-Object { $_.sel })
  if ($sel.Count -ne 1) { return $null }
  return @{ rid = $sel[0].rid; title = $sel[0].title }
}

# The remembered tabs of meetings no surface showed in this read, looked up again.
# $spec: '<code>,<hwnd>,<pid>,<rid>;...' as the app sent it; anything malformed is skipped.
function Read-TabChecks($spec, $surfaces) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrEmpty($spec)) { return ,$out }
  $codes = @($surfaces | ForEach-Object { $_.meetCode })
  foreach ($entry in $spec.Split(';')) {
    if (-not ($entry -match $TAB_WATCH)) { continue }
    $code = $Matches[1]; $hwnd = [long]$Matches[2]; $tpid = [int]$Matches[3]; $rid = $Matches[4]
    if ($codes -contains $code) { continue }
    $h = [IntPtr]::new($hwnd)
    $r = @{ code = $code; hwnd = $hwnd; rid = $rid; processAlive = $false; windowAlive = $false; minimized = $false
            strip = 'unreadable'; present = $false; selected = $false; active = 'none'; activeCode = $null }
    $p = $null
    try { $p = Get-Process -Id $tpid -ErrorAction Stop } catch { $p = $null }
    # Get-Process still lists a process that has exited while anyone holds a handle to it (measured:
    # a killed browser read as alive), so HasExited has the last word.
    $exited = $false
    if ($p -ne $null) { try { $exited = [bool]$p.HasExited } catch { $exited = $false } }
    $r.processAlive = ($p -ne $null -and -not $exited -and $BROWSERS -contains $p.ProcessName)
    if ($r.processAlive -and [MeetWin]::IsWindow($h)) {
      $wpid = 0
      [void][MeetWin]::GetWindowThreadProcessId($h, [ref]$wpid)
      # A recycled handle that now belongs to another process is not the window remembered.
      $r.windowAlive = ($wpid -eq $tpid)
    }
    if ($r.windowAlive) {
      $r.minimized = [bool][MeetWin]::IsIconic($h)
      $el = $null
      try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { $el = $null }
      $items = $null
      if ($el -ne $null -and -not $r.minimized) { try { $items = Read-TabStrip $h $el } catch { $items = $null } }
      if ($null -ne $items) {
        $r.strip = 'ok'
        foreach ($t in $items) {
          if ($t.rid -eq $rid) { $r.present = $true; $r.selected = [bool]$t.sel }
        }
      }
      if ($el -ne $null) {
        try {
          $doc = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
          $v = ''
          if ($doc -ne $null) { try { $v = $doc.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $v = '' } }
          if ($v -match '^https?://') {
            $r.active = 'url'
            try {
              $u = [Uri]$v
              if ($u.Host -eq 'meet.google.com' -and $u.AbsolutePath -match $CODE_PATH) { $r.activeCode = $Matches[1] }
            } catch {}
          }
        } catch {}
      }
    }
    [void]$out.Add($r)
  }
  return ,$out
}
`;

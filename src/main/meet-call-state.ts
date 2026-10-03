/**
 * Whether the user is actually IN a Google Meet call, and whether their Meet microphone is muted.
 *
 * WHY THIS EXISTS
 *   The URL sensor (meet-url-sensor.ts) answers "is a Meet address on screen". That is not the same
 *   question as "is the user in the call", and three things went wrong in the gap:
 *     1. Meet's "You left the meeting / Rejoin" page keeps the address `meet.google.com/<code>`, so
 *        a call the user had left still read as a meeting and the WarpTalk room never ended.
 *     2. Nothing told WarpTalk what the user did with Meet's own mic button, so the WarpTalk mic in
 *        a bridge room could not follow it.
 *     3. Switching tab moves the call into Chrome's picture-in-picture window, a separate top-level
 *        window titled `Meet - <code>` whose document is `about:blank`. The URL sensor's PiP gate
 *        (an origin label in the window chrome) did not recognise it on the machine measured, so
 *        Meet "disappeared" on every tab switch.
 *   All three are answered by the same evidence: which buttons Meet is showing.
 *
 * WHAT WAS MEASURED (2026-10-02, Chrome on Windows 11, Vietnamese Meet UI, one machine)
 *   Raw dumps: __tests__/fixtures/meet-live-2026-10-02/. Every Meet call-control button shares the
 *   class stem `VYBDae-Bz112c-LgbsSe ... hk9qKe ... EXoIMe`; what tells them apart:
 *
 *     lobby      mic "Tắt micrô" `aLTxue jfzJEe`, camera the same tokens, "Tham gia ngay"; NO `RnWvU`.
 *                Chrome already records the microphone for the preview, so Core Audio
 *                (meet-mic-state.ts) cannot tell the lobby from the call.
 *     in call    Leave "Rời khỏi cuộc gọi" `RnWvU xCYCgd` - the only button with `RnWvU`.
 *                mic on  "Tắt micrô" `aLTxue MNEgVb`;  mic muted "Bật micrô" `Y3DJRd GgyKtd`.
 *     PiP        window `Meet - <code>` (no " - Google Chrome" suffix, about 394x497), Document with
 *                an empty Name and URL `about:blank`; inside: mic, camera, Leave (`RnWvU xCYCgd`).
 *                mic on "Tắt micrô" `aLTxue jfzJEe`; mic muted "Bật micrô" `Y3DJRd ZAsEvd`.
 *                Toggling the mic in PiP flips the classes exactly as in the tab.
 *     left       address unchanged; only "Tham gia lại", "Quay lại màn hình chính", "Gửi phản hồi".
 *                No `RnWvU`, no mic button, not one button of the call-control stem.
 *
 *   The mic button has NO TogglePattern, and a muted Meet keeps the microphone open, so neither UIA
 *   patterns nor Core Audio say anything about mute. The button's class and name are all there is.
 *
 *   NOT measured, and therefore not claimed: the Ctrl+D shortcut, Edge, an English (or any non-vi)
 *   Meet UI, the "removed by host" and "call ended for everyone" pages, a minimized Chrome window.
 *
 * TWO TIERS, AND WHY BOTH
 *   class  language-independent, which is why it is the primary tier: `RnWvU` = Leave, `Y3DJRd` =
 *          off, `aLTxue` = on. But Meet's classes are obfuscated build output and can change with
 *          any Meet release, without notice.
 *   name   Meet's own wording for the same buttons (vocabulary below). Survives a class rename,
 *          fails in a language the table does not hold.
 *   When neither tier recognises anything the answer is `unknown` / `muted: null`. It is never a
 *   guess: an "unknown" leaves the WarpTalk mic and room where they are; a wrong "left" ends a
 *   meeting somebody is still in.
 *
 * A TRAP THE DUMPS SHOWED: `aLTxue` / `Y3DJRd` ARE NOT THE MIC'S OWN
 *   The camera button carries the very same tokens as the mic (and share-screen, CC, raise-hand
 *   carry `aLTxue` too). So the tokens give the STATE of a toggle, never WHICH toggle it is. The
 *   mic button is identified by its name where the language is known, and otherwise by position:
 *   in every dump (lobby, call, PiP, two older call dumps) the mic is the first button in document
 *   order that carries one of the two tokens. See `findMicButton`.
 *
 * SHAPE
 *   Like meet-captions.ts: PowerShell only lists buttons (name + class); every judgement is a pure
 *   function here, tested against the real dumps. The listing rides on the URL sensor's existing
 *   helper process (`MEET_SURFACE_SCRIPT` is spliced into its script) - no second process polls.
 */

import { normalizeLabel } from "./meet-caption-vocab.ts";
import { MEET_CODE, childrenOf, type UiaNode } from "./meet-captions.ts";
import type { MeetCallState, MeetSelfMic, MeetWindowGeometry } from "../shared/types.ts";
import type { MeetSighting } from "./meet-url-sensor.ts";
import { parseMeetWindowGeometry, sameMeetWindowGeometry } from "./meet-window-geometry.ts";

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/** One Button under a Meet document: accessible name and HTML class, nothing else. */
export interface MeetButton {
  n: string;
  c: string;
}

/**
 * One place Meet is showing: the active tab of a browser window whose address is
 * `https://meet.google.com/<code>`, or Chrome's picture-in-picture window for a call.
 */
export interface MeetSurface {
  surface: "tab" | "pip";
  /** From the address (tab) or the window title `Meet - <code>` (pip). */
  meetCode: string;
  processId: number | null;
  /**
   * The top-level HWND this surface was read from (the tab's browser window, or the PiP window),
   * so a sighting built from it can still name the window to capture (meet-window-capture.ts).
   * Absent from older helper payloads.
   */
  windowHandle?: number | null;
  /**
   * Where the page content sits in that window (tab surfaces only), for cropping the browser chrome
   * out of the recording. Absent when it could not be read or did not add up; see
   * meet-window-geometry.ts.
   */
  geometry?: MeetWindowGeometry;
  /** The window is minimized. Chrome may stop updating the tree then (not measured). */
  minimized?: boolean;
  /** The listing hit the helper's cap; a control past it may be missing. */
  truncated?: boolean;
  /** Every Button under the document, in document order. */
  buttons: MeetButton[];
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  // PowerShell's ConvertTo-Json collapses a one-element array into the element itself.
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The helper's `surfaces`, defensively: anything malformed is dropped, never trusted. */
export function parseMeetSurfaces(raw: unknown): MeetSurface[] {
  const out: MeetSurface[] = [];
  for (const item of asArray(raw as Record<string, unknown> | Record<string, unknown>[] | null)) {
    if (!item || typeof item !== "object") continue;
    const kind = item.surface;
    const code = item.meetCode;
    if ((kind !== "tab" && kind !== "pip") || typeof code !== "string" || !MEET_CODE.test(code)) continue;
    const pid = item.processId;
    const hwnd = item.windowHandle;
    const buttons: MeetButton[] = [];
    for (const b of asArray(item.buttons as Record<string, unknown> | Record<string, unknown>[] | null)) {
      if (!b || typeof b !== "object") continue;
      buttons.push({ n: typeof b.n === "string" ? b.n : "", c: typeof b.c === "string" ? b.c : "" });
    }
    // Only a tab is ever cropped: the PiP window is never recorded (B18).
    const geometry = kind === "tab" ? parseMeetWindowGeometry(item.geometry) : null;
    out.push({
      surface: kind,
      meetCode: code,
      processId: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      ...(typeof hwnd === "number" && Number.isSafeInteger(hwnd) && hwnd > 0 ? { windowHandle: hwnd } : {}),
      ...(geometry ? { geometry } : {}),
      minimized: item.minimized === true,
      truncated: item.truncated === true,
      buttons,
    });
  }
  return out;
}

/** The Buttons of a dumped UIA tree (the fixtures' shape), in document order. */
export function buttonsFromUiaTree(root: UiaNode): MeetButton[] {
  const out: MeetButton[] = [];
  const visit = (node: UiaNode): void => {
    if (node.type === "Button") out.push({ n: node.name ?? "", c: node.className ?? "" });
    childrenOf(node).forEach(visit);
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The two tiers
// ---------------------------------------------------------------------------------------------

/**
 * Class tokens, as measured on 2026-10-02 (Chrome, Windows 11, vi Meet UI; fixtures
 * meet-live-2026-10-02). Obfuscated by Meet's build: they WILL change one day, and when they do
 * these stop matching, the name tier takes over, and past that everything reads `unknown`.
 */
const LEAVE_TOKEN = "RnWvU"; // Leave call: "RnWvU xCYCgd", tab and PiP. On no other button.
const TOGGLE_OFF_TOKEN = "Y3DJRd"; // mic muted: "Y3DJRd GgyKtd" (tab), "Y3DJRd ZAsEvd" (PiP).
const TOGGLE_ON_TOKEN = "aLTxue"; // mic on: "aLTxue MNEgVb" (call), "aLTxue jfzJEe" (lobby, PiP).

/**
 * Meet's wording, matched exactly after `normalizeLabel` (which also drops a trailing shortcut
 * hint such as "(ctrl + d)"). Only `vi` is backed by the dumps; `en` is Meet's long-standing
 * English wording and has NOT been probed. A wrong or missing entry is safe: an unmatched label
 * matches nothing, and the class tier or `unknown` answers instead.
 *
 * Note the direction: the label is the ACTION, so "Turn off microphone" means the mic is ON.
 */
const NAME_VOCAB = {
  micIsOn: ["Tắt micrô", "Turn off microphone"],
  micIsMuted: ["Bật micrô", "Turn on microphone"],
  camera: ["Tắt máy ảnh", "Bật máy ảnh", "Turn off camera", "Turn on camera"],
  leave: ["Rời khỏi cuộc gọi", "Leave call"],
  rejoin: ["Tham gia lại", "Rejoin"],
} as const;

function labelSet(labels: readonly string[]): Set<string> {
  return new Set(labels.map((label) => normalizeLabel(label)));
}

const MIC_ON_NAMES = labelSet(NAME_VOCAB.micIsOn);
const MIC_MUTED_NAMES = labelSet(NAME_VOCAB.micIsMuted);
const CAMERA_NAMES = labelSet(NAME_VOCAB.camera);
const LEAVE_NAMES = labelSet(NAME_VOCAB.leave);
const REJOIN_NAMES = labelSet(NAME_VOCAB.rejoin);

function tokensOf(button: MeetButton): string[] {
  return button.c.trim().split(/\s+/).filter(Boolean);
}

/**
 * Tailwind-like utility classes ("min-h-[50px]", "hover:bg-..."), which extensions use and Meet
 * never does. Tactiq and friends inject buttons into the Meet page; a button styled like that is
 * not Meet's, whatever its name says. Same rule as meet-captions.ts.
 */
function isInjected(button: MeetButton): boolean {
  const family = tokensOf(button)[0] ?? "";
  return /[[\]:/#]/.test(family);
}

/** What the class says about a toggle: exactly one of the two tokens, or nothing. */
function toggleStateByClass(button: MeetButton): "on" | "off" | null {
  const tokens = tokensOf(button);
  const on = tokens.includes(TOGGLE_ON_TOKEN);
  const off = tokens.includes(TOGGLE_OFF_TOKEN);
  if (on === off) return null;
  return on ? "on" : "off";
}

function micStateByName(button: MeetButton): "on" | "off" | null {
  const name = normalizeLabel(button.n);
  if (MIC_ON_NAMES.has(name)) return "on";
  if (MIC_MUTED_NAMES.has(name)) return "off";
  return null;
}

interface LeaveFinding {
  via: "class" | "name";
}

function findLeaveButton(buttons: MeetButton[]): LeaveFinding | null {
  const meets = buttons.filter((b) => !isInjected(b));
  if (meets.some((b) => tokensOf(b).includes(LEAVE_TOKEN))) return { via: "class" };
  if (meets.some((b) => LEAVE_NAMES.has(normalizeLabel(b.n)))) return { via: "name" };
  return null;
}

interface MicFinding {
  /** Null when the button was found but its state could not be decided (see below). */
  muted: boolean | null;
  via: "class" | "name" | null;
}

/**
 * Meet's own microphone button, and what it says.
 *
 * BY NAME FIRST. Where the language is known the name identifies the button for certain, and the
 * class then gives the state:
 *   name and class agree     -> the answer, `via: "class"` (the primary tier, confirmed)
 *   class says nothing       -> the name's answer, `via: "name"` (Meet renamed its classes)
 *   name and class DISAGREE  -> `muted: null`. One of the two has changed meaning and nothing here
 *                               can tell which; saying so beats muting someone on a coin toss.
 *
 * BY POSITION OTHERWISE (a language the vocabulary does not hold). The tokens alone cannot find
 * the mic - the camera carries the same ones - so this takes the first button in document order
 * with exactly one of the two toggle tokens, which is the mic in every dump taken. It refuses when
 * that button is named as the camera. What it cannot refuse: an unknown-language page that shows
 * a camera toggle and no mic toggle at all would have the camera read as the mic. Meet has not
 * been seen to render that; stated here so nobody assumes it cannot happen.
 */
function findMicButton(buttons: MeetButton[]): MicFinding | null {
  const meets = buttons.filter((b) => !isInjected(b));

  const named = meets.filter((b) => micStateByName(b) !== null);
  if (named.length > 0) {
    const byName = new Set(named.map((b) => micStateByName(b)));
    // Two mic buttons that disagree with each other: the button exists, its state is not known.
    if (byName.size > 1) return { muted: null, via: null };
    const nameState = [...byName][0] as "on" | "off";
    const classStates = new Set(named.map((b) => toggleStateByClass(b)).filter((s) => s !== null));
    if (classStates.size === 0) return { muted: nameState === "off", via: "name" };
    if (classStates.size === 1 && classStates.has(nameState)) return { muted: nameState === "off", via: "class" };
    return { muted: null, via: null };
  }

  const first = meets.find((b) => toggleStateByClass(b) !== null);
  if (!first) return null;
  if (CAMERA_NAMES.has(normalizeLabel(first.n))) return null;
  return { muted: toggleStateByClass(first) === "off", via: "class" };
}

/**
 * Whether the page has a cluster of same-family buttons - Meet's icon-button toolbar. The lobby
 * and the call both do (>= 3 of one class family); the "you left" page has three buttons of three
 * different families. Used only to tell "the controls are gone" from "the controls are there and
 * I cannot read them": no hard-coded class name, only "several siblings of one family".
 */
function hasControlCluster(buttons: MeetButton[]): boolean {
  const counts = new Map<string, number>();
  for (const b of buttons) {
    if (isInjected(b)) continue;
    const family = tokensOf(b)[0];
    if (!family) continue;
    const count = (counts.get(family) ?? 0) + 1;
    if (count >= 3) return true;
    counts.set(family, count);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------------------------

export type MeetCallPhase = MeetCallState["phase"];

export interface MeetCallReading {
  phase: MeetCallPhase;
  via: "tab" | "pip" | null;
  meetCode: string | null;
  /** Why, in a fixed vocabulary - for logs and for the web side's diagnostics, not for display. */
  reason: string;
  /** The window the surface was read from, when it named one. See `MeetCallState.windowHandle`. */
  windowHandle?: number;
  /** Tab surfaces only. See `MeetCallState.windowGeometry`. */
  windowGeometry?: MeetWindowGeometry;
}

export interface MeetSelfMicReading {
  muted: boolean | null;
  /** True when this reading should not be trusted as current (see `MeetSelfMic`). */
  stale: boolean;
  via: "class" | "name" | null;
}

export interface MeetCallClassification {
  call: MeetCallReading;
  mic: MeetSelfMicReading;
  /** The surface the answer came from; null when there was none. */
  surface: MeetSurface | null;
}

const NO_MIC: MeetSelfMicReading = { muted: null, stale: false, via: null };

/**
 * One surface.
 *
 *   tab  Leave button            -> in-call
 *        mic button, no Leave    -> lobby (the green room: joining has not happened yet)
 *        no buttons at all       -> unknown. Chrome's first read of a tab can come back nearly
 *                                   empty while its accessibility tree wakes; that is not a page
 *                                   without controls, it is a page not yet read.
 *        "Rejoin" by name        -> left
 *        no control cluster      -> left: a readable Meet page for this code, and the toolbar is
 *                                   gone. Language- and class-independent.
 *        anything else           -> unknown: a toolbar is there and neither tier can read it (Meet
 *                                   renamed its classes AND the language is not in the table).
 *                                   This is the case that must not be called "left".
 *   pip  Leave or mic button     -> in-call. Chrome only opens this window for a call in progress.
 *        neither                 -> unknown, and the window does not count as Meet at all: its
 *                                   title is written by a page, so a title alone proves nothing.
 */
export function classifyMeetSurface(surface: MeetSurface): MeetCallClassification {
  const { buttons, meetCode } = surface;
  const leave = findLeaveButton(buttons);
  const mic = findMicButton(buttons);
  const micReading: MeetSelfMicReading = mic
    ? // A minimized window is still read, but flagged: whether Chrome keeps the tree current
      // there was not measured.
      { muted: mic.muted, stale: mic.muted !== null && surface.minimized === true, via: mic.muted === null ? null : mic.via }
    : NO_MIC;
  const windowHandle = surface.windowHandle;
  const reading = (phase: MeetCallPhase, reason: string): MeetCallReading => ({
    phase,
    via: surface.surface,
    meetCode,
    reason,
    // Present only when known, so a reading without them looks exactly as it did before.
    ...(typeof windowHandle === "number" ? { windowHandle } : {}),
    ...(surface.surface === "tab" && surface.geometry ? { windowGeometry: surface.geometry } : {}),
  });

  if (surface.surface === "pip") {
    if (leave) return { call: reading("in-call", `leave-button-${leave.via}`), mic: micReading, surface };
    if (mic) return { call: reading("in-call", "pip-mic-button"), mic: micReading, surface };
    return { call: reading("unknown", "pip-without-controls"), mic: NO_MIC, surface };
  }

  if (leave) return { call: reading("in-call", `leave-button-${leave.via}`), mic: micReading, surface };
  if (mic) return { call: reading("lobby", "mic-button-no-leave"), mic: micReading, surface };
  if (buttons.length === 0) return { call: reading("unknown", "empty-tree"), mic: NO_MIC, surface };
  // A listing cut short may have lost the very buttons being looked for.
  if (surface.truncated) return { call: reading("unknown", "listing-truncated"), mic: NO_MIC, surface };
  if (buttons.some((b) => !isInjected(b) && REJOIN_NAMES.has(normalizeLabel(b.n)))) {
    return { call: reading("left", "rejoin-button"), mic: NO_MIC, surface };
  }
  if (!hasControlCluster(buttons)) return { call: reading("left", "no-call-controls"), mic: NO_MIC, surface };
  return { call: reading("unknown", "controls-unrecognised"), mic: NO_MIC, surface };
}

const PHASE_RANK: Record<MeetCallPhase, number> = { "in-call": 3, lobby: 2, left: 1, unknown: 0 };

/**
 * Everything one look found, reduced to one answer: the surface furthest into a call wins, so a
 * "you left" tab of one meeting cannot hide the PiP window of the call the user is in now. Ties go
 * to the first surface, and a tab is listed before a PiP window of the same rank.
 *
 * No surface at all is `unknown`, never `left`: UIA only exposes a window's ACTIVE tab, so a Meet
 * tab the user switched away from (with auto picture-in-picture off) is invisible, not gone.
 */
export function classifyMeetCall(surfaces: MeetSurface[]): MeetCallClassification {
  let best: MeetCallClassification | null = null;
  const ordered = [...surfaces].sort((a, b) => Number(a.surface === "pip") - Number(b.surface === "pip"));
  for (const surface of ordered) {
    const next = classifyMeetSurface(surface);
    if (!best || PHASE_RANK[next.call.phase] > PHASE_RANK[best.call.phase]) best = next;
  }
  if (best) return best;
  return {
    call: { phase: "unknown", via: null, meetCode: null, reason: "no-meet-surface" },
    mic: NO_MIC,
    surface: null,
  };
}

/**
 * The sighting presence reports, once the buttons have had their say.
 *
 * Only one thing changes: a surface that is IN A CALL is a sighting, whatever the URL read said.
 * That is what makes the picture-in-picture window count - `Meet - <code>` over `about:blank` with
 * a Leave or mic button - and it brings the room code along, which the old origin-label read of a
 * PiP window never had. Presence therefore stops flapping from "code" to "no code" on a tab switch.
 *
 * What deliberately does NOT change: a "you left" page is still a sighting. Presence is documented
 * as a raw observation ("a Meet address is on screen"), three consumers read it that way (the
 * bridge offer, the signed-out prompt, the capture target, which only needs the browser's PID),
 * and web builds already shipped act on it. Dropping the sighting would silently change all of
 * them, and would turn any future misread of "left" into "Meet is gone". The phase travels
 * alongside instead, on `bridge:meet-call-state`, and consumers that care opt in.
 *
 * TRUST, stated plainly: a PiP window's title is written by a page, and so are button classes. A
 * hostile page could open its own document picture-in-picture window, title it `Meet - abc-defg-hij`
 * and put a button with the right class in it. The address-based read cannot be forged that way;
 * this one can. What it buys the forger is a bridge OFFER for a room code the user must already
 * have a WarpTalk room for - no capture starts and nothing is sent without the user. That was
 * judged a fair price for not losing Meet on every tab switch; it is the reason the title match is
 * exact, the document must be `about:blank`, and a call control must be present as well.
 */
export function sightingFromScan(sighting: MeetSighting | null, surfaces: MeetSurface[]): MeetSighting | null {
  const best = classifyMeetCall(surfaces);
  if (best.call.phase === "in-call" && best.surface) {
    // The window goes with it: the sighting it replaces may have been read from another window
    // (the URL read prefers a normal window), and a recording must capture the one the call is in.
    const windowHandle = best.surface.windowHandle;
    return {
      meetCode: best.surface.meetCode,
      processId: best.surface.processId,
      ...(typeof windowHandle === "number" ? { windowHandle } : {}),
      via: best.surface.surface === "tab" ? "document" : "pip",
    };
  }
  return sighting;
}

// ---------------------------------------------------------------------------------------------
// The helper side
// ---------------------------------------------------------------------------------------------

/**
 * Spliced into the URL sensor's script (meet-url-sensor.ts), after its own definitions: uses its
 * `MeetWin` class and `$CODE_PATH`. Pure ASCII, and no backticks - it lives in a template literal.
 *
 * It lists and never judges: every Button under the document, name and class, in one cached
 * cross-process call. Nothing is invoked, focused or typed.
 *
 * The PiP gate is here because it decides what gets READ, not what it means: only a browser window
 * whose document is `about:blank` and whose title is exactly `Meet - <code>` (case-sensitive, no
 * " - Google Chrome" suffix - a normal tab on a page titled like that fails both tests).
 *
 * For a tab it also reads where the page sits in its window (Get-MeetGeometry), raw, for the
 * recording's crop; meet-window-geometry.ts judges it. That read is fenced off on every side: a
 * failure there, an entry point missing on an old Windows, a rectangle that is empty or infinite
 * (ConvertTo-Json would write `Infinity` and break the whole answer), all give `geometry = $null`
 * and leave the surface itself exactly as it was.
 */
export const MEET_SURFACE_SCRIPT = String.raw`
Add-Type @'
using System;using System.Runtime.InteropServices;
public class MeetGeom {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
}
'@
# Per-monitor DPI aware (v2 = -4), so GetWindowRect, DWM and UI Automation all answer in physical
# pixels, the unit of a captured frame. Refused when the host already chose (then the thread-level
# call still applies) and absent before Windows 10 1607 (then the cross-check in
# meet-window-geometry.ts drops a geometry whose spaces disagree).
try { [void][MeetGeom]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
try { [void][MeetGeom]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
# DWMWA_EXTENDED_FRAME_BOUNDS: the visible window, without the invisible resize borders.
$DWMWA_EXTENDED_FRAME_BOUNDS = 9
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$PIP_TITLE = '^Meet - ([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})$'
# A call with the people panel open has a few buttons per participant, ahead of the call controls
# in document order. The cap only bounds a pathological page; hitting it is reported, not hidden.
$MAX_BUTTONS = 600
# The windows the last scan found Meet in, so the fast 'state' read can skip the enumeration.
$script:surfaceWindows = New-Object System.Collections.ArrayList

function Get-MeetButtons($doc) {
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cr.Add([System.Windows.Automation.AutomationElement]::ClassNameProperty)
  $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
  $scope = $cr.Activate()
  try { $all = $doc.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) }
  finally { $scope.Dispose() }
  $list = New-Object System.Collections.ArrayList
  $n = [Math]::Min($all.Count, $MAX_BUTTONS)
  for ($i = 0; $i -lt $n; $i++) {
    $b = $all.Item($i)
    [void]$list.Add(@{ n = [string]$b.Cached.Name; c = [string]$b.Cached.ClassName })
  }
  return @{ list = $list; truncated = ($all.Count -gt $MAX_BUTTONS) }
}

# A UI Automation rectangle as [left, top, right, bottom] in whole pixels, or null when it is empty
# or not finite (an off-screen element reads as Rect.Empty, whose edges are infinite).
function ConvertTo-Ltrb($r) {
  if ($r -eq $null -or $r.IsEmpty) { return $null }
  foreach ($v in @($r.Left, $r.Top, $r.Right, $r.Bottom)) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return $null }
  }
  return @([int][Math]::Round($r.Left), [int][Math]::Round($r.Top), [int][Math]::Round($r.Right), [int][Math]::Round($r.Bottom))
}

# Where the page sits in its window, raw: GetWindowRect, DWM's visible frame, UI Automation's
# window rectangle and the Document's. Null for a minimized window or when the basics fail.
function Get-MeetGeometry($w, $doc) {
  if ([MeetWin]::IsIconic($w.H)) { return $null }
  try { [void][MeetGeom]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
  $gr = New-Object MeetGeom+RECT
  if (-not [MeetGeom]::GetWindowRect($w.H, [ref]$gr)) { return $null }
  $win = @($gr.Left, $gr.Top, $gr.Right, $gr.Bottom)
  $efb = $null
  try {
    $er = New-Object MeetGeom+RECT
    if ([MeetGeom]::DwmGetWindowAttribute($w.H, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$er, 16) -eq 0) {
      $efb = @($er.Left, $er.Top, $er.Right, $er.Bottom)
    }
  } catch { $efb = $null }
  $uia = $null
  try { $uia = ConvertTo-Ltrb ([System.Windows.Automation.AutomationElement]::FromHandle($w.H).Current.BoundingRectangle) } catch { $uia = $null }
  $docRect = ConvertTo-Ltrb $doc.Current.BoundingRectangle
  if ($docRect -eq $null) { return $null }
  return @{ win = $win; efb = $efb; uia = $uia; doc = $docRect }
}

# $doc and $value are the Document and its address as Read-Window just read them for this window.
function Get-MeetSurface($w, $doc, $value) {
  if ($doc -eq $null) { return $null }
  $kind = $null
  $code = $null
  if ($value -match '^https?://') {
    try { $uri = [Uri]$value } catch { return $null }
    if ($uri.Host -ne 'meet.google.com') { return $null }
    if (-not ($uri.AbsolutePath -match $CODE_PATH)) { return $null }
    $kind = 'tab'
    $code = $Matches[1]
  } elseif ($value -eq 'about:blank') {
    $tb = New-Object System.Text.StringBuilder 256
    [void][MeetWin]::GetWindowText($w.H, $tb, 256)
    if (-not ($tb.ToString() -cmatch $PIP_TITLE)) { return $null }
    $kind = 'pip'
    $code = $Matches[1]
  } else {
    return $null
  }
  $buttons = Get-MeetButtons $doc
  # Tabs only: the PiP window is never recorded, so it is never cropped either.
  $geometry = $null
  if ($kind -eq 'tab') { try { $geometry = Get-MeetGeometry $w $doc } catch { $geometry = $null } }
  return @{
    surface = $kind; meetCode = $code; processId = $w.Pid; windowHandle = $w.H.ToInt64()
    minimized = [bool][MeetWin]::IsIconic($w.H)
    truncated = [bool]$buttons.truncated
    buttons = $buttons.list
    geometry = $geometry
  }
}

# One pass over the given windows: the URL sighting exactly as before, plus every Meet surface.
function Read-MeetScan($windows) {
  $hit = $null
  $surfaces = New-Object System.Collections.ArrayList
  $seen = New-Object System.Collections.ArrayList
  foreach ($w in $windows) {
    $script:doc = $null
    $script:docValue = ''
    $r = Read-Window $w
    # A normal window wins over a picture-in-picture one: it carries the room code. The pass no
    # longer stops at the first one, because a later window may hold the call itself.
    if ($r -ne $null -and ($hit -eq $null -or ($hit.via -ne 'document' -and $r.via -eq 'document'))) { $hit = $r }
    $s = $null
    try { $s = Get-MeetSurface $w $script:doc $script:docValue } catch { $s = $null }
    if ($s -ne $null) { [void]$surfaces.Add($s); [void]$seen.Add($w) }
  }
  $script:surfaceWindows = $seen
  return @{ ok = $true; sighting = $hit; surfaces = $surfaces }
}

# 'state': re-read only the windows Meet was last found in. Any trouble, or Meet no longer there
# (tab switched, PiP closed), falls back to the full scan - which is also what finds a PiP window
# that has just appeared.
function Read-MeetState {
  if ($script:surfaceWindows.Count -gt 0) {
    try {
      $r = Read-MeetScan @($script:surfaceWindows)
      if ($r.surfaces.Count -gt 0) { return $r }
    } catch {}
  }
  return (Read-MeetScan (Get-BrowserWindows))
}
`;

// ---------------------------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------------------------

export interface MeetCallStateTrackerOptions {
  /**
   * The fast read ("state"), for the loop this tracker runs while Meet is in sight. Rejects for
   * "could not look". Null where there is no such read (macOS, Linux): the tracker then only ever
   * reports `unknown`.
   */
  probe: (() => Promise<MeetSurface[]>) | null;
  /** Called only when the call state changed. */
  emitCallState: (state: MeetCallState) => void;
  /** Called only when the mic reading changed. */
  emitSelfMic: (mic: MeetSelfMic) => void;
  now?: () => number;
  /** The fast loop's gap between reads. */
  intervalMs?: number;
  /** How long a move to `left` / `unknown` must hold, on top of two consecutive reads. */
  confirmMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One second between fast reads. A mute in Meet then reaches the renderer within about a second
 * plus the read itself. The read is one cached FindAll on a window already found: 20-35 ms on
 * the target machine, measured 2026-10-02 against an ordinary page with a handful of buttons - a
 * Meet call was not on screen to time, and its ~30 buttons will cost somewhat more. The loop only
 * runs while presence has Meet in sight - a signed-in user who never opens Meet pays nothing
 * beyond the 3 s presence poll.
 */
const DEFAULT_INTERVAL_MS = 1000;

/**
 * Moving INTO a call (or the lobby) is believed at once: it is positive evidence, and it is what
 * turns the WarpTalk mic on. Moving to `left` or `unknown` is absence of evidence and is believed
 * only after two consecutive reads at least this far apart - a tab re-render, an accessibility
 * tree caught mid-update, or the gap between a tab switch and Chrome raising the PiP window must
 * not end a room. Two reads alone are not enough: the 3 s presence look and the 1 s fast read can
 * land within milliseconds of each other.
 */
const DEFAULT_CONFIRM_MS = 1500;
const CONFIRM_READS: Record<MeetCallPhase, number> = { "in-call": 1, lobby: 1, left: 2, unknown: 2 };

/**
 * The window and its layout count as a change: a Meet tab dragged into a new window, or the
 * bookmarks bar toggled, must reach the web app while the phase stays `in-call` (WT-910).
 */
function sameCall(a: MeetCallState, b: MeetCallReading): boolean {
  return (
    a.phase === b.phase &&
    a.via === b.via &&
    a.meetCode === b.meetCode &&
    a.reason === b.reason &&
    a.windowHandle === b.windowHandle &&
    sameMeetWindowGeometry(a.windowGeometry, b.windowGeometry)
  );
}

/**
 * Turns a stream of looks into the two events the renderer gets, emitting only on change.
 *
 * Fed from two places, on purpose: every presence poll (`ingest`, from the 3 s `look` that already
 * runs) and its own faster loop while Meet is in sight (`setPolling`). One reducer for both means
 * the two cadences cannot disagree about what state the call is in.
 */
export class MeetCallStateTracker {
  private call: MeetCallState;
  private mic: MeetSelfMic;
  private candidate: { phase: MeetCallPhase; reads: number; sinceMs: number } | null = null;
  private polling = false;
  private timer: unknown = null;
  private generation = 0;
  private readonly options: MeetCallStateTrackerOptions;
  private readonly now: () => number;

  constructor(options: MeetCallStateTrackerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const atMs = this.now();
    const reason = options.probe ? "not-watching" : "unsupported-platform";
    this.call = { phase: "unknown", via: null, meetCode: null, reason, atMs };
    this.mic = { muted: null, stale: false, via: null, meetCode: null, atMs };
  }

  /** The current value, for a renderer that subscribed after the last change. */
  get callState(): MeetCallState {
    return this.call;
  }

  get selfMic(): MeetSelfMic {
    return this.mic;
  }

  get isPolling(): boolean {
    return this.polling;
  }

  /** Starts or stops the fast loop. Idempotent. Stopping it forgets nothing. */
  setPolling(on: boolean): void {
    if (!this.options.probe || on === this.polling) return;
    this.polling = on;
    const generation = ++this.generation;
    this.cancelTimer();
    if (on) void this.tick(generation);
  }

  /**
   * Nobody is looking any more (the presence watch was disarmed). Said at once and without the
   * usual confirmation: this is a fact about the sensor, not a reading of the page.
   */
  reset(reason = "not-watching"): void {
    this.polling = false;
    this.generation++;
    this.cancelTimer();
    if (!this.options.probe) return;
    this.candidate = null;
    this.commit({ phase: "unknown", via: null, meetCode: null, reason }, NO_MIC);
  }

  /** One look's worth of surfaces, from either cadence. */
  ingest(surfaces: MeetSurface[]): void {
    const { call, mic } = classifyMeetCall(surfaces);
    this.observe(call, mic);
  }

  /** A look that failed. Counted as "cannot see", which needs confirming like any other. */
  ingestFailure(): void {
    this.observe({ phase: "unknown", via: null, meetCode: null, reason: "probe-failed" }, NO_MIC);
  }

  /** Exposed for tests; the timer calls it. */
  async tick(generation = this.generation): Promise<void> {
    const probe = this.options.probe;
    if (!probe || !this.polling || generation !== this.generation) return;
    let surfaces: MeetSurface[] | null = null;
    try {
      surfaces = await probe();
    } catch {
      surfaces = null;
    }
    if (!this.polling || generation !== this.generation) return;
    if (surfaces) this.ingest(surfaces);
    else this.ingestFailure();
    const setTimer = this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.timer = setTimer(() => void this.tick(generation), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clearTimer = this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.timer);
    this.timer = null;
  }

  private observe(call: MeetCallReading, mic: MeetSelfMicReading): void {
    if (call.phase === this.call.phase) {
      // Same phase: details (tab -> pip, the mic) apply at once. This is the mute path, and it is
      // why mute latency is one read rather than two.
      this.candidate = null;
      this.commit(call, mic);
      return;
    }
    const now = this.now();
    if (!this.candidate || this.candidate.phase !== call.phase) {
      this.candidate = { phase: call.phase, reads: 1, sinceMs: now };
    } else {
      this.candidate.reads += 1;
    }
    const needed = CONFIRM_READS[call.phase];
    const held = now - this.candidate.sinceMs >= (this.options.confirmMs ?? DEFAULT_CONFIRM_MS);
    if (needed > 1 && (this.candidate.reads < needed || !held)) return;
    this.candidate = null;
    this.commit(call, mic);
  }

  private commit(call: MeetCallReading, reading: MeetSelfMicReading): void {
    const atMs = this.now();
    if (!sameCall(this.call, call)) {
      this.call = { ...call, atMs };
      this.options.emitCallState(this.call);
    }

    const last = this.mic;
    let next: Omit<MeetSelfMic, "atMs">;
    if (call.phase === "left") {
      // The call is over: there is no mic to follow, and an old value must not be acted on.
      next = { muted: null, stale: false, via: null, meetCode: call.meetCode };
    } else if (reading.muted !== null) {
      next = { muted: reading.muted, stale: reading.stale, via: reading.via, meetCode: call.meetCode };
    } else {
      // Nothing readable now (Meet out of sight, or a mic button neither tier could decide). The
      // last value is kept and marked stale - but only for the same meeting: a mic state from one
      // call says nothing about the next.
      const sameMeeting = call.meetCode === null || last.meetCode === null || call.meetCode === last.meetCode;
      const muted = sameMeeting ? last.muted : null;
      next = {
        muted,
        stale: muted !== null,
        via: muted !== null ? last.via : null,
        meetCode: call.meetCode ?? (sameMeeting ? last.meetCode : null),
      };
    }
    if (
      next.muted !== last.muted ||
      next.stale !== last.stale ||
      next.via !== last.via ||
      next.meetCode !== last.meetCode
    ) {
      this.mic = { ...next, atMs };
      this.options.emitSelfMic(this.mic);
    }
  }
}

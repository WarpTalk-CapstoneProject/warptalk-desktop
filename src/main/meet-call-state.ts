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
 * "LEFT" NEEDS EVIDENCE, NOT A MISSING TOOLBAR
 *   `left` is said only when Meet's post-call page itself is recognised (its Rejoin / Return to home
 *   screen buttons, by name or by class). A page that merely lacks call controls is `unknown`:
 *   on 2026-10-03 (desktop 0.4.11) a read with no recognisable toolbar - a network blip that also
 *   dropped the WarpTalk LiveKit connection, a tree caught mid-rebuild, a tree holding only an
 *   extension's buttons - was called `left` ("no-call-controls"), and the bridge room stopped its
 *   capture while the user was still in the call. A Meet tab that is really gone is not read from
 *   the page either: on 2026-10-03 a CLOSED tab only ever read `unknown / no-meet-surface` and the
 *   room was never ended. That case is now told apart by the browser's own tab strip (positive
 *   evidence again, never mere absence): see meet-tab-identity.ts and the tracker's `ingest`.
 *
 * HARDENED AFTER A FIELD LOG (2026-10-03, desktop 0.4.11, vi UI): the self-mic answer flapped
 *   muted/unmuted/muted within 2.2 s and was applied to the WarpTalk mic each time. Since then:
 *   the LABEL decides and the class may only confirm it (see `findMicButton`); a contradiction,
 *   two disagreeing surfaces of one call, or a position-tier pick outside the call controls is
 *   `unknown` (the web keeps its last applied value), never "muted"; a changed mute must hold
 *   about a second over two reads before it is reported (`DEFAULT_MIC_HOLD_MS`); and main.log
 *   records what each decision was read from (`MeetSelfMicRead`).
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
import { isWindowHandle } from "./window-handle.ts";
import {
  MeetTabWatch,
  isMeetTabGoneReason,
  parseMeetTabRef,
  type MeetTabCheck,
  type MeetTabIdentity,
  type MeetTabRef,
  type MeetTabVerdict,
  type MeetTabWatchEntry,
} from "./meet-tab-identity.ts";

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
  /**
   * The window's selected TabItem when this tab surface was read (tab surfaces only): what lets a
   * closed Meet tab be told from a background one later. Absent when the tab strip could not be
   * read, and from older helper payloads. See meet-tab-identity.ts.
   */
  tab?: MeetTabRef;
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
    const tab = kind === "tab" ? parseMeetTabRef(item.tab) : null;
    out.push({
      surface: kind,
      meetCode: code,
      processId: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      ...(isWindowHandle(hwnd) ? { windowHandle: hwnd } : {}),
      ...(geometry ? { geometry } : {}),
      ...(tab ? { tab } : {}),
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
  /** The post-call page's second button. vi measured (meet-s4-left-1), en not probed. */
  returnHome: ["Quay lại màn hình chính", "Return to home screen"],
} as const;

function labelSet(labels: readonly string[]): Set<string> {
  return new Set(labels.map((label) => normalizeLabel(label)));
}

const MIC_ON_NAMES = labelSet(NAME_VOCAB.micIsOn);
const MIC_MUTED_NAMES = labelSet(NAME_VOCAB.micIsMuted);
const CAMERA_NAMES = labelSet(NAME_VOCAB.camera);
const LEAVE_NAMES = labelSet(NAME_VOCAB.leave);
const REJOIN_NAMES = labelSet(NAME_VOCAB.rejoin);
const RETURN_HOME_NAMES = labelSet(NAME_VOCAB.returnHome);

/**
 * The post-call page's own buttons by class (meet-s4-left-1, 2026-10-02): Rejoin carries `Ac0tsd`,
 * Return to home screen `ctOmyb`; neither token is on any button of the lobby, call or PiP dumps.
 * The class tier for "left", so a Meet UI in a language the table does not hold can still say it.
 * Obfuscated like every Meet class: when they change this stops matching and the answer is
 * `unknown` - never the other way round.
 */
const LEFT_PAGE_TOKENS = ["Ac0tsd", "ctOmyb"];

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
  evidence: MeetSelfMicEvidence;
}

/** At most this much of a label or class string goes into main.log. */
const EVIDENCE_TEXT_MAX = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_TEXT_MAX ? `${flat.slice(0, EVIDENCE_TEXT_MAX)}...` : flat;
}

function evidenceFor(
  rule: MeetSelfMicRule,
  button: MeetButton | null,
  extra: Partial<MeetSelfMicEvidence> = {},
): MeetSelfMicEvidence {
  return {
    rule,
    label: button ? clip(button.n) : null,
    byLabel: button ? micStateByName(button) : null,
    byClass: button ? toggleStateByClass(button) : null,
    classes: button ? clip(button.c) : null,
    micLabelled: 0,
    ...extra,
  };
}

/** The call-control family: the first class token of Meet's Leave button, when there is one. */
function callControlFamily(buttons: MeetButton[]): string | null {
  const leave = buttons.find((b) => !isInjected(b) && tokensOf(b).includes(LEAVE_TOKEN));
  return leave ? (tokensOf(leave)[0] ?? null) : null;
}

/**
 * Meet's own microphone button, and what it says.
 *
 * WHAT CAN BE READ. Through UI Automation, Meet's mic button exposes its accessible name and its
 * class, nothing else: no TogglePattern (so Meet sets no aria-pressed on it - Chrome would expose
 * one), and `data-is-muted` is a data attribute, which never reaches the accessibility tree. The
 * most authoritative signal left is therefore the LABEL: it is the action Meet will perform and
 * what a screen reader announces, and Meet rewrites it on every toggle. The class tokens are
 * styling - `aLTxue` sits on half the toolbar, `Y3DJRd` on any red toggle - so they only ever
 * confirm the label, or stand in for it where the language is unknown.
 *
 * BY LABEL FIRST. Where the language is known the label identifies the button for certain, and
 * gives its state:
 *   label, class agrees       -> the answer, `via: "class"` (both tiers, confirmed)
 *   label, class says nothing -> the label's answer, `via: "name"` (Meet renamed its classes)
 *   label, class DISAGREES    -> `muted: null`. One of the two changed meaning (or the tree was
 *                                caught mid-update) and nothing here can tell which; an unknown
 *                                leaves the WarpTalk mic where it is, a wrong "muted" silences it.
 *   two mic labels disagree   -> `muted: null`, for the same reason.
 *
 * BY POSITION OTHERWISE (a language the vocabulary does not hold, or a label Meet has not been
 * seen to use). The tokens alone cannot find the mic - the camera carries the same ones - so this
 * takes the first button in document order with exactly one of the two toggle tokens, which is
 * the mic in every dump taken. It refuses when that button is named as the camera, and when it is
 * not of the call-control family (the Leave button's first class token, when Leave is on screen):
 * the people panel and the video tiles come BEFORE the toolbar in document order, and a red
 * button there must not read as "you are muted". What it cannot refuse: an unknown-language page
 * that shows a camera toggle and no mic toggle at all would have the camera read as the mic. Meet
 * has not been seen to render that; stated here so nobody assumes it cannot happen.
 */
function findMicButton(buttons: MeetButton[]): MicFinding | null {
  const meets = buttons.filter((b) => !isInjected(b));

  const named = meets.filter((b) => micStateByName(b) !== null);
  if (named.length > 0) {
    const micLabelled = named.length;
    const byName = new Set(named.map((b) => micStateByName(b)));
    // Two mic buttons that disagree with each other: the button exists, its state is not known.
    if (byName.size > 1) {
      return { muted: null, via: null, evidence: evidenceFor("labels-conflict", named[0], { micLabelled }) };
    }
    const nameState = [...byName][0] as "on" | "off";
    const classStates = new Set(named.map((b) => toggleStateByClass(b)).filter((s) => s !== null));
    // The button the answer is read from, for the log: the one whose class spoke, if any did.
    const shown = named.find((b) => toggleStateByClass(b) !== null) ?? named[0];
    if (classStates.size === 0) {
      return { muted: nameState === "off", via: "name", evidence: evidenceFor("label", shown, { micLabelled }) };
    }
    if (classStates.size === 1 && classStates.has(nameState)) {
      return { muted: nameState === "off", via: "class", evidence: evidenceFor("label+class", shown, { micLabelled }) };
    }
    return { muted: null, via: null, evidence: evidenceFor("label-class-conflict", shown, { micLabelled }) };
  }

  const first = meets.find((b) => toggleStateByClass(b) !== null);
  if (!first) return null;
  if (CAMERA_NAMES.has(normalizeLabel(first.n))) return null;
  const family = callControlFamily(meets);
  if (family !== null && tokensOf(first)[0] !== family) {
    return { muted: null, via: null, evidence: evidenceFor("position-not-call-control", first) };
  }
  return { muted: toggleStateByClass(first) === "off", via: "class", evidence: evidenceFor("position", first) };
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

/**
 * Positive evidence that this is Meet's post-call page ("You left the meeting" and its kin), or
 * null. Absence of call controls is NOT evidence; see "LEFT NEEDS EVIDENCE" above.
 */
function findLeftPage(buttons: MeetButton[]): string | null {
  const meets = buttons.filter((b) => !isInjected(b));
  if (meets.some((b) => REJOIN_NAMES.has(normalizeLabel(b.n)))) return "rejoin-button";
  if (meets.some((b) => RETURN_HOME_NAMES.has(normalizeLabel(b.n)))) return "return-home-button";
  if (meets.some((b) => tokensOf(b).some((t) => LEFT_PAGE_TOKENS.includes(t)))) return "left-page-class";
  return null;
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
  /**
   * The browser window hosting the Meet TAB, when the surface named one. Tab readings only: the PiP
   * window's HWND would change this on every tab/PiP switch, and the PiP window is never recorded.
   * See `MeetCallState.windowHandle`.
   */
  windowHandle?: number;
  /** Tab surfaces only. See `MeetCallState.windowGeometry`. */
  windowGeometry?: MeetWindowGeometry;
}

/** `MeetCallStateTracker.latestReading`: the newest reading, before confirmation. */
export interface MeetLatestReading {
  phase: MeetCallPhase;
  via: "tab" | "pip" | null;
  /** The tab's window; absent for PiP, no surface, or a surface without a handle. */
  windowHandle?: number;
  /** Date.now() when it came back. */
  atMs: number;
}

export interface MeetSelfMicReading {
  muted: boolean | null;
  /** True when this reading should not be trusted as current (see `MeetSelfMic`). */
  stale: boolean;
  via: "class" | "name" | null;
}

/**
 * Which rule produced (or refused) a mic reading. For main.log only.
 *   label+class                label and class agree
 *   label                      label only; the class carried neither toggle token
 *   label-class-conflict       label and class disagree -> unknown
 *   labels-conflict            two buttons with mic labels disagree -> unknown
 *   position                   no known label; first toggle-styled call control
 *   position-not-call-control  no known label; the first toggle-styled button is not a call control
 *   surfaces-conflict          two surfaces of the same call disagree -> unknown
 *   none                       no mic button found at all
 */
export type MeetSelfMicRule =
  | "label+class"
  | "label"
  | "label-class-conflict"
  | "labels-conflict"
  | "position"
  | "position-not-call-control"
  | "surfaces-conflict"
  | "none";

/**
 * What the mic reading was taken from, so the next field log can say WHY it read muted. Holds
 * Meet's own UI strings (the button's accessible name and class), never caption or transcript
 * text; both are clipped.
 */
export interface MeetSelfMicEvidence {
  rule: MeetSelfMicRule;
  /** The accessible name of the button the answer was read from, as Meet exposed it. */
  label: string | null;
  /** What the label says: "on" = "Turn off microphone" (mic live), "off" = muted. */
  byLabel: "on" | "off" | null;
  /** What the class's toggle tokens say. */
  byClass: "on" | "off" | null;
  classes: string | null;
  /** How many buttons carried a microphone label (more than one is worth knowing about). */
  micLabelled: number;
  /** With more than one surface of the same call: each one's reading, e.g. ["tab:on", "pip:off"]. */
  surfaces?: string[];
  minimized?: boolean;
}

export interface MeetCallClassification {
  call: MeetCallReading;
  mic: MeetSelfMicReading;
  /** The surface the answer came from; null when there was none. */
  surface: MeetSurface | null;
  /** How `mic` was decided. Diagnostics only; absent when nothing resembling a mic was seen. */
  micEvidence?: MeetSelfMicEvidence;
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
 *        control cluster         -> unknown: a toolbar is there and neither tier can read it (Meet
 *                                   renamed its classes AND the language is not in the table).
 *                                   Checked first: a post-call button inside a live toolbar is
 *                                   not a post-call page.
 *        post-call page buttons  -> left: Rejoin / Return to home screen, by name or by class.
 *        anything else           -> unknown ("no-call-controls"): the controls are not visible,
 *                                   and that alone says nothing - a reconnecting overlay, a tree
 *                                   caught mid-rebuild, an extension's buttons only. Never "left".
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
  const micEvidence = mic ? { ...mic.evidence, ...(surface.minimized ? { minimized: true } : {}) } : undefined;
  const reading = (phase: MeetCallPhase, reason: string): MeetCallReading => ({
    phase,
    via: surface.surface,
    meetCode,
    reason,
    // Present only when known, so a reading without them looks exactly as it did before. Tab only:
    // a PiP reading carries no window (sightingFromScan still takes the PiP HWND off the surface).
    ...(surface.surface === "tab" && isWindowHandle(windowHandle) ? { windowHandle } : {}),
    ...(surface.surface === "tab" && surface.geometry ? { windowGeometry: surface.geometry } : {}),
  });
  const withMic = (call: MeetCallReading): MeetCallClassification => ({
    call,
    mic: micReading,
    surface,
    ...(micEvidence ? { micEvidence } : {}),
  });

  if (surface.surface === "pip") {
    if (leave) return withMic(reading("in-call", `leave-button-${leave.via}`));
    if (mic) return withMic(reading("in-call", "pip-mic-button"));
    return { call: reading("unknown", "pip-without-controls"), mic: NO_MIC, surface };
  }

  if (leave) return withMic(reading("in-call", `leave-button-${leave.via}`));
  if (mic) return withMic(reading("lobby", "mic-button-no-leave"));
  if (buttons.length === 0) return { call: reading("unknown", "empty-tree"), mic: NO_MIC, surface };
  // A listing cut short may have lost the very buttons being looked for.
  if (surface.truncated) return { call: reading("unknown", "listing-truncated"), mic: NO_MIC, surface };
  if (hasControlCluster(buttons)) return { call: reading("unknown", "controls-unrecognised"), mic: NO_MIC, surface };
  const leftPage = findLeftPage(buttons);
  if (leftPage) return { call: reading("left", leftPage), mic: NO_MIC, surface };
  return { call: reading("unknown", "no-call-controls"), mic: NO_MIC, surface };
}

const PHASE_RANK: Record<MeetCallPhase, number> = { "in-call": 3, lobby: 2, left: 1, unknown: 0 };

/**
 * Everything one look found, reduced to one answer: the surface furthest into a call wins, so a
 * "you left" tab of one meeting cannot hide the PiP window of the call the user is in now. Ties go
 * to the first surface, and a tab is listed before a PiP window of the same rank.
 *
 * STICKY WINDOW (`preferWindowHandle`): windows are listed in Z-order, so with two Meet tabs in two
 * windows in the same phase, merely focusing the other window would flip the answer's window - and
 * the web app re-arms its recording capture on every window change. A tie therefore goes to the
 * tab in the window already reported, while it is still a candidate of that rank.
 *
 * No surface at all is `unknown`, never `left`: UIA only exposes a window's ACTIVE tab, so a Meet
 * tab the user switched away from (with auto picture-in-picture off) is invisible, not gone. (The
 * tracker may still turn such a read into `left` when the tab strip proves the tab gone; that is
 * decided there, from evidence this function never sees - meet-tab-identity.ts.)
 */
export function classifyMeetCall(
  surfaces: MeetSurface[],
  options: { preferWindowHandle?: number | null } = {},
): MeetCallClassification {
  let best: MeetCallClassification | null = null;
  const all: MeetCallClassification[] = [];
  const prefer = isWindowHandle(options.preferWindowHandle) ? options.preferWindowHandle : null;
  const ordered = [...surfaces].sort((a, b) => Number(a.surface === "pip") - Number(b.surface === "pip"));
  for (const surface of ordered) {
    const next = classifyMeetSurface(surface);
    all.push(next);
    if (!best || PHASE_RANK[next.call.phase] > PHASE_RANK[best.call.phase]) {
      best = next;
    } else if (
      prefer !== null &&
      PHASE_RANK[next.call.phase] === PHASE_RANK[best.call.phase] &&
      next.call.windowHandle === prefer &&
      best.call.windowHandle !== prefer
    ) {
      best = next;
    }
  }
  if (best) return reconcileMic(best, all);
  return {
    call: { phase: "unknown", via: null, meetCode: null, reason: "no-meet-surface" },
    mic: NO_MIC,
    surface: null,
  };
}

/**
 * The mic of a call seen on more than one surface - a tab plus a picture-in-picture window, or the
 * same meeting open in two browser windows. The phase rule above picks ONE surface (tab before
 * PiP, then the window already reported, then window order), and which one is not a statement
 * about the user's mic: the presence look enumerates windows in z-order, the fast read re-reads
 * them in the order of the previous look, and the sticky window only holds while it stays a
 * candidate. When two surfaces of the same call disagree, taking the chosen one's mic would flip
 * the answer with focus and cadence - a sub-second muted/unmuted flap. Disagreement is therefore
 * `unknown`, and a chosen surface whose mic could not be read borrows the agreeing answer of
 * another. The call reading (phase, window, geometry) is left exactly as chosen.
 */
function reconcileMic(best: MeetCallClassification, all: MeetCallClassification[]): MeetCallClassification {
  const peers = all.filter(
    (c) => c.call.phase === best.call.phase && c.call.meetCode === best.call.meetCode && c.micEvidence !== undefined,
  );
  if (peers.length < 2) return best;
  const surfaces = peers.map((c) => `${c.surface?.surface ?? "?"}:${c.mic.muted === null ? "?" : c.mic.muted ? "off" : "on"}`);
  const states = new Set(peers.map((c) => c.mic.muted).filter((m) => m !== null));
  if (states.size > 1) {
    const evidence = { ...(best.micEvidence as MeetSelfMicEvidence), rule: "surfaces-conflict" as const, surfaces };
    return { ...best, mic: NO_MIC, micEvidence: evidence };
  }
  if (best.mic.muted === null && states.size === 1) {
    const donor = peers.find((c) => c.mic.muted !== null) as MeetCallClassification;
    return { ...best, mic: donor.mic, micEvidence: { ...(donor.micEvidence as MeetSelfMicEvidence), surfaces } };
  }
  return { ...best, micEvidence: { ...(best.micEvidence as MeetSelfMicEvidence), surfaces } };
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
export function sightingFromScan(
  sighting: MeetSighting | null,
  surfaces: MeetSurface[],
  options: { preferWindowHandle?: number | null } = {},
): MeetSighting | null {
  // The SAME window preference as the tracker's (MeetCallStateTracker.windowPreference): with two
  // Meet windows in one phase, presence and the call state must name the same window, or an arm
  // that falls back to presence would capture the other one (#56 review).
  const best = classifyMeetCall(surfaces, options);
  if (best.call.phase === "in-call" && best.surface) {
    // The window goes with it: the sighting it replaces may have been read from another window
    // (the URL read prefers a normal window), and a recording must capture the one the call is in.
    const windowHandle = best.surface.windowHandle;
    return {
      meetCode: best.surface.meetCode,
      processId: best.surface.processId,
      ...(isWindowHandle(windowHandle) ? { windowHandle } : {}),
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
# The window-geometry P/Invokes live in the sensor script's MeetWin class (meet-url-sensor.ts): one
# Add-Type, one C# compile, for the one helper process both scripts run in.
# Per-monitor DPI aware (v2 = -4), so GetWindowRect, DWM and UI Automation all answer in physical
# pixels, the unit of a captured frame. Refused when the host already chose (then the thread-level
# call still applies) and absent before Windows 10 1607 (then the cross-check in
# meet-window-geometry.ts drops a geometry whose spaces disagree).
try { [void][MeetWin]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
try { [void][MeetWin]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
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
# $el is the window's element as Read-Window already looked it up (null: not known, skipped).
function Get-MeetGeometry($w, $doc, $el) {
  if ([MeetWin]::IsIconic($w.H)) { return $null }
  try { [void][MeetWin]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
  $gr = New-Object MeetWin+RECT
  if (-not [MeetWin]::GetWindowRect($w.H, [ref]$gr)) { return $null }
  $win = @($gr.Left, $gr.Top, $gr.Right, $gr.Bottom)
  $efb = $null
  try {
    $er = New-Object MeetWin+RECT
    if ([MeetWin]::DwmGetWindowAttribute($w.H, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$er, 16) -eq 0) {
      $efb = @($er.Left, $er.Top, $er.Right, $er.Bottom)
    }
  } catch { $efb = $null }
  $uia = $null
  if ($el -ne $null) { try { $uia = ConvertTo-Ltrb $el.Current.BoundingRectangle } catch { $uia = $null } }
  $docRect = ConvertTo-Ltrb $doc.Current.BoundingRectangle
  if ($docRect -eq $null) { return $null }
  return @{ win = $win; efb = $efb; uia = $uia; doc = $docRect }
}

# $doc and $value are the Document and its address as Read-Window just read them for this window,
# $el the window's own element.
function Get-MeetSurface($w, $doc, $value, $el) {
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
  if ($kind -eq 'tab') { try { $geometry = Get-MeetGeometry $w $doc $el } catch { $geometry = $null } }
  # Tabs only: which TabItem is selected in this window now, so a closed tab can later be told from
  # a background one (meet-tab-identity.ts). Fenced off like the geometry.
  $tab = $null
  if ($kind -eq 'tab') { try { $tab = Get-SelectedTab $w $el } catch { $tab = $null } }
  return @{
    surface = $kind; meetCode = $code; processId = $w.Pid; windowHandle = $w.H.ToInt64()
    minimized = [bool][MeetWin]::IsIconic($w.H)
    truncated = [bool]$buttons.truncated
    buttons = $buttons.list
    geometry = $geometry
    tab = $tab
  }
}

# One pass over the given windows: the URL sighting exactly as before, plus every Meet surface.
# $full says the windows were every browser window (Get-BrowserWindows), not only the last ones
# Meet was in: only a full pass can say a Meet tab is nowhere (meet-tab-identity.ts).
function Read-MeetScan($windows, $full) {
  $hit = $null
  $surfaces = New-Object System.Collections.ArrayList
  $seen = New-Object System.Collections.ArrayList
  foreach ($w in $windows) {
    $script:doc = $null
    $script:docValue = ''
    $script:el = $null
    $r = Read-Window $w
    # A normal window wins over a picture-in-picture one: it carries the room code. The pass no
    # longer stops at the first one, because a later window may hold the call itself.
    if ($r -ne $null -and ($hit -eq $null -or ($hit.via -ne 'document' -and $r.via -eq 'document'))) { $hit = $r }
    $s = $null
    try { $s = Get-MeetSurface $w $script:doc $script:docValue $script:el } catch { $s = $null }
    if ($s -ne $null) { [void]$surfaces.Add($s); [void]$seen.Add($w) }
  }
  $script:surfaceWindows = $seen
  return @{ ok = $true; sighting = $hit; surfaces = $surfaces; full = [bool]$full }
}

# 'state': re-read only the windows Meet was last found in. Any trouble, or Meet no longer there
# (tab switched, PiP closed), falls back to the full scan - which is also what finds a PiP window
# that has just appeared.
function Read-MeetState {
  if ($script:surfaceWindows.Count -gt 0) {
    try {
      $r = Read-MeetScan @($script:surfaceWindows) $false
      if ($r.surfaces.Count -gt 0) { return $r }
    } catch {}
  }
  return (Read-MeetScan (Get-BrowserWindows) $true)
}
`;

// ---------------------------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------------------------

/**
 * One look, as the tracker takes it: the surfaces, plus what the helper found about the Meet tabs
 * the tracker remembers (meet-tab-identity.ts). A bare array is the older shape: no tab evidence.
 */
export interface MeetTrackerRead {
  surfaces: MeetSurface[];
  /** The look enumerated every browser window. Only then can a tab be called gone. */
  full?: boolean;
  tabChecks?: MeetTabCheck[];
}

/** For main.log: a Meet tab remembered, or what the remembered tabs added up to. */
export type MeetTabEvent =
  | { kind: "identity"; identity: MeetTabIdentity }
  | ({ kind: "verdict" } & MeetTabVerdict);

export interface MeetCallStateTrackerOptions {
  /**
   * The fast read ("state"), for the loop this tracker runs while Meet is in sight. Rejects for
   * "could not look". Null where there is no such read (macOS, Linux): the tracker then only ever
   * reports `unknown`.
   */
  probe: (() => Promise<MeetSurface[] | MeetTrackerRead>) | null;
  /** Called only when the call state changed. */
  emitCallState: (state: MeetCallState) => void;
  /**
   * Called only when the mic reading changed. `evidence` is what the read that settled it saw
   * (absent when nothing was read): for main.log, not for the renderer.
   */
  emitSelfMic: (mic: MeetSelfMic, evidence?: MeetSelfMicRead) => void;
  /**
   * Called when what the sensor SEES about the mic changes, whether or not that changes the
   * answer: a toggle now held for confirmation, a contradiction, a flap that was dropped. Optional;
   * main.log only. Nothing is reported while the same evidence repeats.
   */
  onMicRead?: (read: MeetSelfMicRead) => void;
  /** How long a changed mute must hold, over two reads or more, before it is reported. */
  micHoldMs?: number;
  now?: () => number;
  /** The fast loop's gap between reads. */
  intervalMs?: number;
  /** How long a move to `left` / `unknown` must hold, on top of two consecutive reads. */
  confirmMs?: number;
  /** How long a `left` read from the tab strip (tab closed) must hold, over two full looks. */
  tabConfirmMs?: number;
  /** main.log: a Meet tab remembered, and each change of what a surface-less read decided. */
  onTabEvent?: (event: MeetTabEvent) => void;
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

/**
 * A changed mute is believed once it has held this long, over two reads at least. The first value
 * of a meeting is believed at once (it is not a change: nothing was applied before it).
 *
 * WHY: a field log (desktop 0.4.11, 2026-10-03) shows Meet's mic reported muted, unmuted and muted
 * again within 2.2 s (09:20:12.539 / 12.975 / 14.731). Two answers 436 ms apart can only come from
 * the two cadences (the 3 s presence look and the 1 s fast read) disagreeing, and each answer was
 * applied to the WarpTalk mic at once. A real click in Meet holds; a tree caught mid-update, or two
 * surfaces read in a different order, does not. The cost is up to one more read of latency on a
 * real mute (about 1-2 s instead of about 1 s).
 */
const DEFAULT_MIC_HOLD_MS = 1000;

/** One read's worth of mic evidence, as main.log gets it. */
export interface MeetSelfMicRead extends Partial<MeetSelfMicEvidence> {
  /** What this read alone says. */
  muted: boolean | null;
  phase: MeetCallPhase;
  surface: "tab" | "pip" | null;
  /**
   *   applied   the answer (or an unchanged answer) was taken
   *   held      a changed mute, waiting to hold for micHoldMs
   *   dropped   a held change that did not last (the flap this exists for)
   *   unknown   nothing decidable; the last value is kept, marked stale
   */
  outcome: "applied" | "held" | "dropped" | "unknown";
}
const CONFIRM_READS: Record<MeetCallPhase, number> = { "in-call": 1, lobby: 1, left: 2, unknown: 2 };

/**
 * A `left` because the Meet tab is gone (meet-tab-identity.ts) is believed only after it was seen
 * by two FULL looks (every browser window enumerated) at least this far apart - on top of the
 * usual two reads. A tab being dragged to another window, or a window being re-created, must not
 * end a room; with the 3 s presence look this makes about 3-6 s from the close to the verdict.
 */
export const DEFAULT_TAB_CONFIRM_MS = 3000;

/**
 * How long after the last good layout of the tab's window a tab reading of the same window that
 * came back without one still carries it. A single geometry read that failed its checks (a UI
 * Automation call caught mid-update, a DWM call that failed) must not turn the recording's crop off
 * for a second and show the tab strip; a layout that stays unreadable for longer than this is
 * dropped. Time, not a count of reads: the 1 s state reads and the 3 s presence looks interleave,
 * so "three reads" was about two seconds, not three.
 *
 * Dropped at once by a different window, a minimized one, and any committed reading that is not of
 * a tab (PiP, `unknown` with no surface): a layout from before a PiP stretch says nothing about the
 * window after it - the bookmarks bar may have been toggled, the window resized meanwhile.
 */
export const GEOMETRY_HOLD_MS = 3_000;

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
  private candidate: {
    phase: MeetCallPhase;
    reads: number;
    sinceMs: number;
    /** Full looks that read the Meet tab as gone, and when the first of them came. */
    tabReads: number;
    tabSinceMs: number | null;
  } | null = null;
  /** The Meet tabs remembered, to tell a closed tab from a background one. */
  private readonly tabs = new MeetTabWatch();
  /** The meeting whose tabs are watched: the code of the last read that showed a Meet surface. */
  private watchCode: string | null = null;
  /**
   * The `left` committed because the Meet tab is gone. While no Meet surface is seen again it IS
   * the answer to every surface-less (or failed) read: otherwise the next `no-meet-surface` would
   * turn it back into `unknown`, and the tabs it was judged from are no longer there to judge.
   */
  private closedVerdict: MeetCallReading | null = null;
  private lastTabVerdictKey = "";
  /** A changed mute waiting to hold (see DEFAULT_MIC_HOLD_MS). */
  private micCandidate: { muted: boolean; meetCode: string | null; sinceMs: number } | null = null;
  private lastReadKey = "";
  private polling = false;
  private timer: unknown = null;
  private generation = 0;
  /** The last good layout of the tab's window, and when it was read. See GEOMETRY_HOLD_MS. */
  private heldGeometry: { windowHandle: number; geometry: MeetWindowGeometry; atMs: number } | null = null;
  /** The newest reading that came back, BEFORE confirmation; see `latestReading`. */
  private latest: MeetLatestReading | null = null;
  /**
   * The browser window of the last committed TAB reading. Unlike `call.windowHandle` it survives a
   * PiP or `unknown` stretch (those readings carry no tab window), so returning to the tab with two
   * Meet windows open still goes to the window reported before. See `windowPreference`.
   */
  private lastTabWindowHandle: number | null = null;
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

  /**
   * Date.now() of the last read that came back (from either cadence), or null. The committed state
   * only changes when a reading differs, so this - not `callState.atMs` - is how recent the last
   * look was. It is NOT how fresh the committed state is: see `latestReading`.
   */
  get lastReadAtMs(): number | null {
    return this.latest?.atMs ?? null;
  }

  /**
   * The newest reading that came back, as read - before the confirmation `left` / `unknown` need.
   * While it disagrees with `callState` the committed state is being doubted (for ~2 s), and an arm
   * must not lean on it: the Meet tab may already be gone from that window (meetWindowForArm).
   * Failed reads do not count; null before the first read and after `reset`.
   */
  get latestReading(): MeetLatestReading | null {
    return this.latest;
  }

  /**
   * The window a tie between two Meet windows goes to (classifyMeetCall's `preferWindowHandle`).
   * The URL sensor classifies its sighting with the same value (sightingFromScan), so presence and
   * the call state never name different windows.
   */
  get windowPreference(): number | null {
    return this.lastTabWindowHandle;
  }

  /**
   * The remembered Meet tabs the helper should look up again on the next read (meet-url-sensor.ts
   * sends them with the command). Empty once the verdict is in, and when nothing is remembered.
   */
  get tabWatchList(): MeetTabWatchEntry[] {
    if (this.closedVerdict) return [];
    return this.tabs.watchList(this.watchCode);
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
    this.heldGeometry = null;
    this.latest = null;
    this.lastTabWindowHandle = null;
    this.tabs.forget();
    this.watchCode = null;
    this.closedVerdict = null;
    this.lastTabVerdictKey = "";
    this.commit({ phase: "unknown", via: null, meetCode: null, reason }, NO_MIC);
  }

  /**
   * One look's worth of surfaces, from either cadence. `read` carries the tab evidence of the look
   * (meet-tab-identity.ts); without it a read with no Meet surface stays `unknown` as before.
   */
  ingest(surfaces: MeetSurface[], read: Omit<MeetTrackerRead, "surfaces"> = {}): void {
    const atMs = this.now();
    const classified = classifyMeetCall(surfaces, {
      preferWindowHandle: this.lastTabWindowHandle,
    });
    const { mic, surface, micEvidence } = classified;
    let call = classified.call;
    let tabGone = false;

    const sightings = surfaces
      .filter((s) => s.surface === "tab")
      .map((s) => ({ meetCode: s.meetCode, windowHandle: s.windowHandle, processId: s.processId, tab: s.tab }));
    for (const identity of this.tabs.record(sightings, atMs)) {
      this.options.onTabEvent?.({ kind: "identity", identity });
    }

    if (call.via !== null) {
      // Meet is in sight again (this call or another): whatever was decided without it is over.
      this.watchCode = call.meetCode;
      this.closedVerdict = null;
      this.lastTabVerdictKey = "";
    } else if (this.closedVerdict) {
      call = this.closedVerdict;
    } else {
      const verdict = this.tabs.judge(this.watchCode, read.tabChecks ?? [], read.full === true);
      if (verdict) {
        this.reportTabVerdict(verdict);
        if (verdict.left) {
          // The meeting's code goes with it: the web app trusts a code-less reading for any room.
          call = { phase: "left", via: "tab", meetCode: verdict.meetCode, reason: verdict.reason };
          tabGone = true;
        } else {
          // Still `unknown`, still code-less, exactly as before - only the reason says more.
          call = { ...call, reason: verdict.reason };
        }
      }
    }

    this.latest = {
      phase: call.phase,
      via: call.via,
      ...(isWindowHandle(call.windowHandle) ? { windowHandle: call.windowHandle } : {}),
      atMs,
    };
    this.observe(this.withHeldGeometry(call, surface, atMs), mic, micEvidence, tabGone);
  }

  private reportTabVerdict(verdict: MeetTabVerdict): void {
    const key = JSON.stringify([verdict.meetCode, verdict.left, verdict.reason, verdict.tabs]);
    if (key === this.lastTabVerdictKey) return;
    this.lastTabVerdictKey = key;
    this.options.onTabEvent?.({ kind: "verdict", ...verdict });
  }

  /**
   * See GEOMETRY_HOLD_MS. Readings that are not of a tab neither use nor change the hold here; the
   * commit of one drops it (`commit`).
   */
  private withHeldGeometry(call: MeetCallReading, surface: MeetSurface | null, atMs: number): MeetCallReading {
    const windowHandle = call.windowHandle;
    if (call.via !== "tab" || !isWindowHandle(windowHandle)) return call;
    if (surface?.minimized) {
      this.heldGeometry = null;
      return call;
    }
    if (call.windowGeometry) {
      this.heldGeometry = { windowHandle, geometry: call.windowGeometry, atMs };
      return call;
    }
    const held = this.heldGeometry;
    if (held && held.windowHandle === windowHandle && atMs - held.atMs <= GEOMETRY_HOLD_MS) {
      return { ...call, windowGeometry: held.geometry };
    }
    this.heldGeometry = null;
    return call;
  }

  /** A look that failed. Counted as "cannot see", which needs confirming like any other. */
  ingestFailure(): void {
    // A failed read is not a surface seen again: a tab-closed verdict stands through it.
    this.observe(this.closedVerdict ?? { phase: "unknown", via: null, meetCode: null, reason: "probe-failed" }, NO_MIC);
  }

  /** Exposed for tests; the timer calls it. */
  async tick(generation = this.generation): Promise<void> {
    const probe = this.options.probe;
    if (!probe || !this.polling || generation !== this.generation) return;
    let result: MeetSurface[] | MeetTrackerRead | null = null;
    try {
      result = await probe();
    } catch {
      result = null;
    }
    if (!this.polling || generation !== this.generation) return;
    if (Array.isArray(result)) this.ingest(result);
    else if (result) this.ingest(result.surfaces, { full: result.full, tabChecks: result.tabChecks });
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

  /** `tabGone`: this reading is a `left` because the Meet tab is gone, read by a full look. */
  private observe(call: MeetCallReading, mic: MeetSelfMicReading, evidence?: MeetSelfMicEvidence, tabGone = false): void {
    if (call.phase === this.call.phase) {
      // Same phase: details (tab -> pip) apply at once; the mic goes through its own hold.
      this.candidate = null;
      this.commit(call, mic, evidence);
      return;
    }
    const now = this.now();
    if (!this.candidate || this.candidate.phase !== call.phase) {
      this.candidate = { phase: call.phase, reads: 1, sinceMs: now, tabReads: 0, tabSinceMs: null };
    } else {
      this.candidate.reads += 1;
    }
    if (tabGone) {
      this.candidate.tabReads += 1;
      if (this.candidate.tabSinceMs === null) this.candidate.tabSinceMs = now;
    }
    const needed = CONFIRM_READS[call.phase];
    const held = now - this.candidate.sinceMs >= (this.options.confirmMs ?? DEFAULT_CONFIRM_MS);
    // A tab-gone `left` also needs a second full look, DEFAULT_TAB_CONFIRM_MS after the first.
    const tabHeld =
      !tabGone ||
      (this.candidate.tabReads >= 2 &&
        this.candidate.tabSinceMs !== null &&
        now - this.candidate.tabSinceMs >= (this.options.tabConfirmMs ?? DEFAULT_TAB_CONFIRM_MS));
    if ((needed > 1 && (this.candidate.reads < needed || !held)) || !tabHeld) {
      // Not the call read before, and not yet believed either: a pending mute did not hold here.
      this.micCandidate = null;
      return;
    }
    this.candidate = null;
    this.commit(call, mic, evidence);
  }

  private commit(call: MeetCallReading, reading: MeetSelfMicReading, evidence?: MeetSelfMicEvidence): void {
    const atMs = this.now();
    if (call.via === "tab") {
      if (isWindowHandle(call.windowHandle)) this.lastTabWindowHandle = call.windowHandle;
    } else {
      // PiP, or no surface at all: whatever layout was held belongs to before this stretch.
      this.heldGeometry = null;
    }
    if (!sameCall(this.call, call)) {
      this.call = { ...call, atMs };
      this.options.emitCallState(this.call);
    }
    if (call.phase === "left" && call.via === "tab" && isMeetTabGoneReason(call.reason) && call.meetCode) {
      // Said once, and kept (see closedVerdict). The tabs it was judged from are done with.
      this.closedVerdict = call;
      this.tabs.forget(call.meetCode);
    }

    const last = this.mic;
    const sameMeetingAsLast = call.meetCode === null || last.meetCode === null || call.meetCode === last.meetCode;
    let outcome: MeetSelfMicRead["outcome"] = "applied";
    let next: Omit<MeetSelfMic, "atMs">;
    if (call.phase === "left") {
      // The call is over: there is no mic to follow, and an old value must not be acted on.
      this.micCandidate = null;
      next = { muted: null, stale: false, via: null, meetCode: call.meetCode };
    } else if (reading.muted !== null && (last.muted === null || !sameMeetingAsLast || reading.muted === last.muted)) {
      // The first value of a meeting, or the value already applied: taken as it is.
      if (this.micCandidate) outcome = "dropped";
      this.micCandidate = null;
      next = { muted: reading.muted, stale: reading.stale, via: reading.via, meetCode: call.meetCode };
    } else if (reading.muted !== null) {
      // A change. Believed once it has held (DEFAULT_MIC_HOLD_MS); until then nothing moves.
      const holdMs = this.options.micHoldMs ?? DEFAULT_MIC_HOLD_MS;
      const pending = this.micCandidate;
      if (!pending || pending.muted !== reading.muted || pending.meetCode !== call.meetCode) {
        this.micCandidate = { muted: reading.muted, meetCode: call.meetCode, sinceMs: atMs };
      }
      const since = (this.micCandidate as { sinceMs: number }).sinceMs;
      if (holdMs > 0 && atMs - since < holdMs) {
        outcome = "held";
        next = { muted: last.muted, stale: last.stale, via: last.via, meetCode: last.meetCode };
      } else {
        this.micCandidate = null;
        next = { muted: reading.muted, stale: reading.stale, via: reading.via, meetCode: call.meetCode };
      }
    } else {
      // An unreadable or contradictory read breaks a pending change's streak.
      if (this.micCandidate) outcome = "dropped";
      else outcome = "unknown";
      this.micCandidate = null;
      // Nothing readable now (Meet out of sight, or a mic button neither tier could decide). The
      // last value is kept and marked stale - but only for the same meeting: a mic state from one
      // call says nothing about the next.
      const muted = sameMeetingAsLast ? last.muted : null;
      next = {
        muted,
        stale: muted !== null,
        via: muted !== null ? last.via : null,
        meetCode: call.meetCode ?? (sameMeetingAsLast ? last.meetCode : null),
      };
    }
    const read: MeetSelfMicRead = {
      muted: reading.muted,
      phase: call.phase,
      surface: call.via,
      ...(evidence ?? {}),
      outcome,
    };
    this.reportRead(read);
    if (
      next.muted !== last.muted ||
      next.stale !== last.stale ||
      next.via !== last.via ||
      next.meetCode !== last.meetCode
    ) {
      this.mic = { ...next, atMs };
      this.options.emitSelfMic(this.mic, evidence ? read : undefined);
    }
  }

  /** Tells main.log what the sensor saw, once per change of what it saw. */
  private reportRead(read: MeetSelfMicRead): void {
    if (!this.options.onMicRead) return;
    // Everything but the raw class string: Meet can add hover/focus tokens without meaning anything.
    const key = JSON.stringify([
      read.muted,
      read.phase,
      read.surface,
      read.rule,
      read.label,
      read.byLabel,
      read.byClass,
      read.micLabelled,
      read.surfaces,
      read.minimized,
      read.outcome,
    ]);
    if (key === this.lastReadKey) return;
    this.lastReadKey = key;
    this.options.onMicRead(read);
  }
}

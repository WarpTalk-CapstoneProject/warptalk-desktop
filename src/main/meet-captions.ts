/**
 * Live speaker names for Google Meet participants, read from Meet's own captions (CC).
 *
 * WarpTalk's STT writes the transcript; what it cannot know is WHO on the Meet side spoke. Meet's
 * captions name the speaker, so the desktop reads them from the capturer's Chrome window through UI
 * Automation (meet-caption-sensor.ts) and hands `(speaker, time, text)` to the web app, which
 * matches them against its own segments. Only the capturer (normally the host) needs CC on.
 *
 * Everything that DECIDES lives here, as pure functions over a plain UIA tree, so it is tested
 * against real trees captured from a live call (__tests__/fixtures). The PowerShell helper only
 * dumps the tree and, when asked, invokes one button it is told to find by exact identity.
 *
 * WHICH BUTTON IS MEET'S CC BUTTON
 *   Extensions inject their own caption buttons (Tactiq: "Toggle captions visibility"; anything
 *   could add a "Turn on captions"). A candidate must satisfy ALL of:
 *     1. a Button with Invoke;
 *     2. a direct child of Meet's call-controls Group - found by its localized name, or failing
 *        that structurally: the one Group whose direct Button children mostly (>50 %, >= 5) share
 *        one class family;
 *     3. its class family (first class token) is that group's majority family - Meet's toolbar
 *        buttons share an obfuscated family, injected ones do not. Never a hard-coded class name:
 *        only "same family as its siblings". Utility-class families ("min-h-[50px]") never count;
 *     4. its name is a CC label in the vocabulary (meet-caption-vocab.ts), which also gives state.
 *   Exactly one candidate, or no action.
 *
 * WHAT IS NEVER DONE
 *   No focus, no keystrokes, no opening menus (a narrow window folds CC into "More options": that
 *   is reported as `cc-button-hidden`), and never an invoke while the label says captions are ON -
 *   the helper re-reads the label right before invoking and refuses if it changed.
 *
 * THE CAPTIONS REGION, AS MEASURED (Chrome 154, vi UI)
 *   Flat in the control view: speaker Text, then one Text PER VISUAL LINE of that block, with
 *   whitespace-only Texts as separators. Every past block stays (history), Meet rewrites text in
 *   place - also in blocks that are no longer last ("Innova ok." -> "Innova") - and a speaker Text
 *   is indistinguishable from a line by type. Headers are recognised by: the first Text; the
 *   localized self label; a name shown on a participant tile; a name recognised before; a short
 *   unpunctuated Text that repeats. See `parseCaptionTexts`.
 *
 * TIME
 *   `alignedNow()` is monotonic (performance.now) anchored to Date.now() once at load, so it is on
 *   the same axis as the loopback PCM `capturedAtMs` (Date.now()) and never jumps backwards. Meet's
 *   captions trail speech by roughly 0.5-1.5 s; consumers should match with that tolerance.
 *   `tStartMs` is when the block first appeared, `tEndMs` when its final text was first seen,
 *   `tStableMs` when it was judged final (tEndMs + ~1.2 s).
 *
 * OPEN RISK (measured once, not yet explained): during a 55 s stretch nothing in the tree changed,
 * then a long passage appeared at once - likely Chrome throttling accessibility updates while the
 * Meet window was occluded. Such a jump is ingested as one batch and tagged `tConfidence:"batch"`
 * so the web side matches it by text, not time; `stale` in the status flags a silent tree while
 * audio is being captured. To verify live.
 */

import {
  callControlsLocales,
  captionStateFromLabel,
  isCaptionsRegionName,
  isSelfSpeaker,
  normalizeLabel,
} from "./meet-caption-vocab.ts";
import type {
  EnsureMeetCaptionsResult,
  MeetCaptionEvent,
  MeetCaptionStatus,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/** One UIA control-view element, in the shape the fixtures and the helper share. */
export interface UiaNode {
  type: string;
  name: string;
  className?: string;
  automationId?: string;
  offscreen?: boolean;
  patterns?: string[] | string;
  children?: UiaNode[] | UiaNode | null;
}

/** PowerShell's ConvertTo-Json collapses one-element arrays; read children either way. */
export function childrenOf(node: UiaNode): UiaNode[] {
  const kids = node.children;
  if (!kids) return [];
  return Array.isArray(kids) ? kids : [kids];
}

function patternsOf(node: UiaNode): string[] {
  const p = node.patterns;
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

/** Depth-first, document order; the first node `match` accepts. */
function findNode(node: UiaNode, match: (node: UiaNode) => boolean): UiaNode | null {
  if (match(node)) return node;
  for (const child of childrenOf(node)) {
    const hit = findNode(child, match);
    if (hit) return hit;
  }
  return null;
}

function walk(node: UiaNode, visit: (node: UiaNode, parent: UiaNode | null) => void, parent: UiaNode | null = null): void {
  visit(node, parent);
  for (const child of childrenOf(node)) walk(child, visit, node);
}

/** Flat helper output (`p` = parent index, -1 for the root) back into a tree. */
export interface FlatUiaNode {
  p: number;
  t: string;
  n: string;
  c: string;
  a: string;
  o: boolean;
  i: boolean;
}

export function treeFromFlat(nodes: FlatUiaNode[]): UiaNode | null {
  const built: UiaNode[] = nodes.map((n) => ({
    type: n.t,
    name: n.n ?? "",
    className: n.c ?? "",
    automationId: n.a ?? "",
    offscreen: Boolean(n.o),
    patterns: n.i ? ["Invoke"] : [],
    children: [],
  }));
  let root: UiaNode | null = null;
  nodes.forEach((n, index) => {
    if (n.p < 0 || n.p >= built.length || n.p === index) {
      root ??= built[index];
      return;
    }
    (built[n.p].children as UiaNode[]).push(built[index]);
  });
  return root;
}

/** The first class token, which Meet's components share across a family of controls. */
export function classFamily(className: string | undefined): string {
  return (className ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Tailwind-like utility classes, which extensions use and Meet never does. */
function isUtilityFamily(family: string): boolean {
  return family.length === 0 || /[[\]:/#]/.test(family);
}

// ---------------------------------------------------------------------------------------------
// The CC button
// ---------------------------------------------------------------------------------------------

interface CallControls {
  group: UiaNode;
  family: string;
  /** Locales whose "Call controls" label the group carries; null when found structurally. */
  locales: string[] | null;
}

function majorityFamily(group: UiaNode): { family: string; count: number; total: number } | null {
  const buttons = childrenOf(group).filter((c) => c.type === "Button");
  if (buttons.length === 0) return null;
  const counts = new Map<string, number>();
  for (const b of buttons) {
    const f = classFamily(b.className);
    if (isUtilityFamily(f)) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: { family: string; count: number; total: number } | null = null;
  for (const [family, count] of counts) {
    if (!best || count > best.count) best = { family, count, total: buttons.length };
  }
  return best;
}

export function findCallControls(root: UiaNode): { ok: true; controls: CallControls } | { ok: false; reason: "call-controls-not-found" | "call-controls-ambiguous" } {
  const named: CallControls[] = [];
  const structural: CallControls[] = [];
  walk(root, (node) => {
    if (node.type !== "Group") return;
    const majority = majorityFamily(node);
    if (!majority || majority.count * 2 <= majority.total) return;
    const locales = callControlsLocales(node.name);
    if (locales && majority.count >= 3) named.push({ group: node, family: majority.family, locales });
    else if (majority.count >= 5) structural.push({ group: node, family: majority.family, locales: null });
  });
  const pool = named.length > 0 ? named : structural;
  if (pool.length === 1) return { ok: true, controls: pool[0] };
  return { ok: false, reason: pool.length === 0 ? "call-controls-not-found" : "call-controls-ambiguous" };
}

/** Exactly what the helper needs to find the same button again and nothing else. */
export interface CaptionButtonTarget {
  name: string;
  className: string;
  /** Accessible name of the call-controls group (may be empty when found structurally). */
  groupName: string;
}

export type CaptionButtonIdentification =
  | { ok: true; state: "on" | "off"; target: CaptionButtonTarget; locales: string[] }
  | {
      ok: false;
      reason:
        | "call-controls-not-found"
        | "call-controls-ambiguous"
        | "cc-button-hidden"
        | "cc-button-ambiguous"
        | "unknown-locale";
    };

export function identifyCaptionButton(root: UiaNode): CaptionButtonIdentification {
  const found = findCallControls(root);
  if (!found.ok) return found;
  const { group, family, locales: groupLocales } = found.controls;

  const candidates: { node: UiaNode; state: "on" | "off"; locales: string[] }[] = [];
  for (const child of childrenOf(group)) {
    if (child.type !== "Button") continue;
    if (!patternsOf(child).includes("Invoke")) continue;
    if (classFamily(child.className) !== family) continue;
    const label = captionStateFromLabel(child.name);
    if (label) candidates.push({ node: child, ...label });
  }

  if (candidates.length > 1) return { ok: false, reason: "cc-button-ambiguous" };
  if (candidates.length === 0) {
    // A known language whose call controls carry no CC button: the window is too narrow and Meet
    // moved it into "More options". Otherwise we cannot tell hidden from untranslated.
    const knownLocale =
      groupLocales !== null || findNode(root, (n) => n.type === "Group" && isCaptionsRegionName(n.name)) !== null;
    return { ok: false, reason: knownLocale ? "cc-button-hidden" : "unknown-locale" };
  }
  const { node, state, locales } = candidates[0];
  return {
    ok: true,
    state,
    locales,
    target: { name: node.name, className: node.className ?? "", groupName: group.name ?? "" },
  };
}

// ---------------------------------------------------------------------------------------------
// The captions region
// ---------------------------------------------------------------------------------------------

function hasDescendant(node: UiaNode, type: string): boolean {
  return childrenOf(node).some((c) => c.type === type || hasDescendant(c, type));
}

/**
 * The captions Group: by its localized name, or structurally - the first Group (without buttons)
 * that follows Meet's caption-settings cluster (a ComboBox plus >= 2 same-family buttons) among
 * the same siblings.
 */
export function findCaptionsRegion(root: UiaNode): UiaNode | null {
  const named = findNode(root, (node) => node.type === "Group" && isCaptionsRegionName(node.name));
  if (named) return named;

  let structural: UiaNode | null = null;
  findNode(root, (parent) => {
    const kids = childrenOf(parent);
    if (!kids.some((k) => k.type === "ComboBox")) return false;
    const families = new Map<string, number>();
    for (const k of kids) {
      if (k.type !== "Button") continue;
      const f = classFamily(k.className);
      if (!isUtilityFamily(f)) families.set(f, (families.get(f) ?? 0) + 1);
    }
    const settingsFamily = [...families.entries()].find(([, n]) => n >= 2)?.[0];
    if (!settingsFamily) return false;
    let lastSettings = -1;
    kids.forEach((k, i) => {
      if (k.type === "Button" && classFamily(k.className) === settingsFamily) lastSettings = i;
    });
    const next = kids.slice(lastSettings + 1).find((k) => k.type === "Group");
    if (!next || next.offscreen || hasDescendant(next, "Button")) return false;
    structural = next;
    return true;
  });
  return structural;
}

/** All non-blank Text names under the region, in document order. */
export function captionTexts(region: UiaNode): string[] {
  const out: string[] = [];
  walk(region, (node) => {
    if (node !== region && node.type === "Text" && node.name && node.name.trim().length > 0) {
      out.push(node.name.trim());
    }
  });
  return out;
}

const SENTENCE_END = /[.?!,;:…。？！，、]$/;
/** Longer than any display name; also the bound of the repeated-header rule. */
const MAX_SPEAKER_CHARS = 60;

/**
 * Meet's own components carry an obfuscated, mixed-case class family ("oZRSLe"). An extension's
 * markup carries none or readable lower-case utility classes ("wrap-anywhere flex-1").
 */
function isMeetFamily(family: string): boolean {
  return !isUtilityFamily(family) && /[A-Z]/.test(family);
}

/**
 * Names on participant tiles: a Text that is the only child of its Group, outside the region and
 * the call controls. Meet promotes the active speaker into a visible tile, which is what makes
 * this a useful header signal.
 *
 * Only Meet's own Groups count, and only a Text that can be a name. A transcript extension
 * (Tactiq) lists every caption line as a Group holding one Text, in the same document: read as
 * tiles, those lines became "participants" and each one then split the real speaker's turn into
 * a block named after their own words.
 */
export function tileNames(root: UiaNode, exclude: (UiaNode | null)[]): Set<string> {
  const names = new Set<string>();
  const skip = new Set(exclude.filter(Boolean) as UiaNode[]);
  const visit = (node: UiaNode): void => {
    if (skip.has(node)) return;
    const kids = childrenOf(node);
    if (node.type === "Group" && kids.length === 1 && kids[0].type === "Text" && isMeetFamily(classFamily(node.className))) {
      const name = kids[0].name.trim();
      if (name && name.length <= MAX_SPEAKER_CHARS && !SENTENCE_END.test(name)) names.add(name);
    }
    kids.forEach(visit);
  };
  visit(root);
  return names;
}

export interface CaptionBlock {
  speaker: string;
  text: string;
  isSelf: boolean;
}

/** How many caption lines `SpokenLines` remembers; a Meet history holds far fewer. */
const MAX_SPOKEN_LINES = 500;

/**
 * Every caption line already read as someone's words -> the speaker of the turn it was read in.
 * See `parseCaptionTexts`: this is what makes a turn keep the name it was first given.
 */
export type SpokenLines = Map<string, string>;

/**
 * Splits the flat Text list into (speaker, text) blocks. Lines of a block are joined with a space.
 *
 * A Text starts a block when it is the first one, the self label, a known participant name (tile
 * or seen before), or a short (<= 60 chars) Text without sentence punctuation that occurs more
 * than once - a speaker name repeats with every turn, a wrapped caption line almost never does.
 * Weakness, accepted: a speaker who is on no tile and speaks once is merged into the previous block.
 *
 * A TURN KEEPS ITS NAME (`spoken`, which this function reads and adds to)
 *     Once a line has been read as a speaker's words it stays that speaker's: a later reading
 *     cannot promote it to a header, so the name of a turn is taken once and not derived again
 *     from a tree that may by then say something else. Only a name already accepted (self,
 *     `knownSpeakers`) or the repeat rule outranks it. When Meet trims its history in the middle
 *     of a turn the first Text is such a line, and the block it opens carries the remembered
 *     speaker instead of being named after the line.
 */
export function parseCaptionTexts(
  texts: string[],
  knownSpeakers: Set<string> = new Set(),
  spoken?: SpokenLines,
): CaptionBlock[] {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  const repeats = (t: string): boolean =>
    (counts.get(t) ?? 0) > 1 && t.length <= MAX_SPEAKER_CHARS && !SENTENCE_END.test(t);
  const isHeader = (t: string, index: number): boolean => {
    if (isSelfSpeaker(t) || knownSpeakers.has(t)) return true;
    if (spoken?.has(t)) return repeats(t);
    return index === 0 || repeats(t);
  };
  const remember = (line: string, speaker: string): void => {
    if (!spoken || knownSpeakers.has(line)) return;
    spoken.delete(line);
    spoken.set(line, speaker);
    if (spoken.size > MAX_SPOKEN_LINES) spoken.delete(spoken.keys().next().value as string);
  };

  const blocks: CaptionBlock[] = [];
  texts.forEach((t, index) => {
    if (isHeader(t, index)) {
      blocks.push({ speaker: t, text: "", isSelf: isSelfSpeaker(t) });
      return;
    }
    if (blocks.length === 0) {
      // Only a remembered line gets here: the head of its turn scrolled out of Meet's history.
      const speaker = spoken?.get(t) ?? t;
      blocks.push({ speaker, text: "", isSelf: isSelfSpeaker(speaker) });
    }
    const last = blocks[blocks.length - 1];
    last.text = last.text ? `${last.text} ${t}` : t;
    remember(t, last.speaker);
  });
  return blocks;
}

export interface CaptionReading {
  /** Null when the captions region is not on screen (CC off, or not yet rendered). */
  blocks: CaptionBlock[] | null;
}

/**
 * One snapshot of the Meet tab -> its caption blocks. `known` gains every header seen, `spoken`
 * every line read as speech (see `parseCaptionTexts`); a caller reading a stream passes the same
 * two on every reading.
 */
export function readCaptions(
  root: UiaNode,
  known: Set<string> = new Set(),
  spoken: SpokenLines = new Map(),
): CaptionReading {
  const region = findCaptionsRegion(root);
  if (!region) return { blocks: null };
  const controls = findCallControls(root);
  const tiles = tileNames(root, [region, controls.ok ? controls.controls.group : null]);
  // A tile that repeats words already spoken is not a participant.
  const speakers = new Set([...known, ...[...tiles].filter((name) => !spoken.has(name))]);
  const blocks = parseCaptionTexts(captionTexts(region), speakers, spoken);
  for (const b of blocks) known.add(b.speaker);
  return { blocks };
}

// ---------------------------------------------------------------------------------------------
// Stable caption events
// ---------------------------------------------------------------------------------------------

/** Monotonic, anchored once to wall clock: same axis as loopback `capturedAtMs`, never backwards. */
const CLOCK_ANCHOR = Date.now() - performance.now();
export function alignedNow(): number {
  return Math.round(CLOCK_ANCHOR + performance.now());
}

function comparable(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Same utterance, allowing Meet's in-place rewrites (case, punctuation, a trailing word). */
export function textsRelated(a: string, b: string): boolean {
  const x = comparable(a);
  const y = comparable(b);
  if (x === y) return true;
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(short.slice(0, Math.min(12, short.length)))) return true;
  let common = 0;
  while (common < short.length && short[common] === long[common]) common++;
  return common >= short.length * 0.5;
}

interface TrackedBlock {
  id: string;
  speaker: string;
  text: string;
  isSelf: boolean;
  firstSeenMs: number;
  lastChangeMs: number;
  emittedText: string | null;
  /** When this block was last emitted (stable or interim); null before its first emission. */
  lastEmitMs: number | null;
  confidence: "live" | "batch";
}

export interface CaptionTrackerOptions {
  meetCode: string;
  /** Unchanged this long counts as final. Meet rewrites partials, so not shorter. */
  stableMs?: number;
  /** More new text than this in one snapshot is a batch (normal growth is ~10-30 chars/0.6 s). */
  batchChars?: number;
  /** A gap between reads longer than this makes the next change a batch. */
  gapMs?: number;
  /**
   * When set, a block that is still growing is also emitted (as `caption`, then `update`) at most
   * once per `interimMs` while its text changes, instead of only once it has been unchanged for
   * `stableMs`. Off (undefined) by default; `MeetCaptionStream` turns it on.
   *
   * WHY (bug B3): Meet keeps ONE block per speaker turn and grows it while they talk, so a
   * stable-only tracker names a speaker only after they STOP (+ stableMs + the hop to Redis). The
   * STT worker attributes each stand-in line the moment it is recognised - mid-turn for early
   * sentences - against the hints already in Redis, so it never saw the current speaker's name and
   * every Meet line fell back to "Google Meet participants". Interim emissions put the speaker's
   * name in Redis while the turn is still going.
   */
  interimMs?: number;
}

/**
 * Turns successive whole-region readings into caption events.
 *
 * Identity is the block's index in Meet's history list, after aligning for a trimmed or cleared
 * history: the first current block must match (speaker + related text) the tracked block at the
 * same offset, else the offset is searched; no match means the region was replaced. A block is
 * emitted once its text has been unchanged for `stableMs` (`kind:"caption"`); if Meet rewrites it
 * afterwards it is emitted again with the same `blockId` (`kind:"update"`) - consumers keep the
 * latest. Self blocks are tracked for alignment and never emitted. With `interimMs` a growing block
 * is also emitted while it grows (its `tStableMs` is then the emission time, not a verdict).
 */
export class CaptionTracker {
  private readonly meetCode: string;
  private readonly stableMs: number;
  private readonly batchChars: number;
  private readonly gapMs: number;
  private readonly interimMs: number | null;
  private tracked: TrackedBlock[] = [];
  private nextId = 1;
  private readonly epoch = Math.random().toString(36).slice(2, 8);
  private lastIngestMs: number | null = null;
  private gapPending: "unavailable" | "stale" | null = null;
  /** Whether the stream was stale or unavailable; stamped on events as `stale`. */
  stale = false;
  /** Last time any block changed; drives the `stale` flag. */
  lastChangeMs: number | null = null;

  constructor(options: CaptionTrackerOptions) {
    this.meetCode = options.meetCode;
    this.stableMs = options.stableMs ?? 1200;
    this.batchChars = options.batchChars ?? 160;
    this.gapMs = options.gapMs ?? 2500;
    this.interimMs = typeof options.interimMs === "number" && options.interimMs > 0 ? options.interimMs : null;
  }

  private newBlock(b: CaptionBlock, now: number, confidence: "live" | "batch"): TrackedBlock {
    return {
      id: `${this.epoch}-${this.nextId++}`,
      speaker: b.speaker,
      text: b.text,
      isSelf: b.isSelf,
      firstSeenMs: now,
      lastChangeMs: now,
      emittedText: null,
      lastEmitMs: null,
      confidence,
    };
  }

  private alignOffset(blocks: CaptionBlock[]): number {
    if (this.tracked.length === 0 || blocks.length === 0) return 0;
    const matches = (t: TrackedBlock, b: CaptionBlock): boolean =>
      t.speaker === b.speaker && (t.emittedText === null || textsRelated(t.text, b.text));
    for (let d = 0; d < this.tracked.length; d++) {
      if (matches(this.tracked[d], blocks[0])) return d;
    }
    return this.tracked.length;
  }

  /** One reading. `blocks` null = region not visible: nothing changes, stable ones still emit. */
  ingest(now: number, blocks: CaptionBlock[] | null): MeetCaptionEvent[] {
    const events: MeetCaptionEvent[] = [];
    const gap = this.gapPending === "unavailable" || (this.lastIngestMs !== null && now - this.lastIngestMs > this.gapMs);
    const first = this.lastIngestMs === null;
    this.lastIngestMs = now;
    if (blocks === null) return this.collect(now, events, false);

    const offset = this.alignOffset(blocks);
    const dropped = this.tracked.slice(0, offset);
    const previous = this.tracked.slice(offset);

    let grown = 0;
    for (let j = 0; j < blocks.length; j++) {
      const old = previous[j];
      if (!old) grown += blocks[j].text.length;
      else if (old.text !== blocks[j].text || old.speaker !== blocks[j].speaker) {
        grown += Math.max(0, blocks[j].text.length - old.text.length);
      }
    }
    // The first reading of a stream holds history of unknown age; a big jump or a read gap is a
    // burst Chrome held back. Either way the time is not when it was said.
    // After a stale stretch the threshold drops: the first words after real silence are a few
    // dozen characters, a passage Chrome held back is far more.
    const threshold = this.gapPending === "stale" ? this.batchChars / 2.5 : this.batchChars;
    const batch = first || gap || grown > threshold;
    const confidence = batch ? "batch" : "live";

    const next: TrackedBlock[] = [];
    let changed = false;
    blocks.forEach((b, j) => {
      const old = previous[j];
      if (!old) {
        // A history Meet rebuilt (cleared, re-rendered) shows blocks we already emitted: keep
        // their identity rather than announcing them again.
        const reuse = dropped.findIndex((t) => t.speaker === b.speaker && textsRelated(t.text, b.text));
        if (reuse !== -1) {
          const [again] = dropped.splice(reuse, 1);
          if (again.text !== b.text) {
            again.text = b.text;
            again.lastChangeMs = now;
            changed = true;
          }
          next.push(again);
          return;
        }
        next.push(this.newBlock(b, now, confidence));
        changed = true;
        return;
      }
      if (old.text !== b.text || old.speaker !== b.speaker) {
        old.text = b.text;
        old.speaker = b.speaker;
        old.isSelf = b.isSelf;
        old.lastChangeMs = now;
        if (batch) old.confidence = "batch";
        changed = true;
      }
      next.push(old);
    });
    if (changed) {
      this.lastChangeMs = now;
      this.gapPending = null;
    }
    this.tracked = next;
    // Blocks Meet dropped from the head will never change again: finalize them now.
    this.collect(now, events, true, dropped);
    return this.collect(now, events, false);
  }

  /**
   * The sensor could not see the tree (tab inactive, minimized, error) or saw it frozen: whatever
   * changes next arrived in a burst, so it is a batch however small.
   */
  markGap(kind: "unavailable" | "stale"): void {
    if (this.gapPending !== "unavailable") this.gapPending = kind;
  }

  /** Emits every block with unemitted text, stable or not (stream stop). */
  flush(now: number): MeetCaptionEvent[] {
    return this.collect(now, [], true);
  }

  private collect(now: number, events: MeetCaptionEvent[], force: boolean, pool: TrackedBlock[] = this.tracked): MeetCaptionEvent[] {
    for (const t of pool) {
      if (t.isSelf || !t.text || t.text === t.emittedText) continue;
      if (!force && now - t.lastChangeMs < this.stableMs) {
        // Still growing: an interim emission, throttled, when enabled (see `interimMs`).
        const interimDue =
          this.interimMs !== null && (t.lastEmitMs === null || now - t.lastEmitMs >= this.interimMs);
        if (!interimDue) continue;
      }
      events.push({
        meetCode: this.meetCode,
        blockId: t.id,
        kind: t.emittedText === null ? "caption" : "update",
        speaker: t.speaker,
        text: t.text,
        tStartMs: t.firstSeenMs,
        tEndMs: t.lastChangeMs,
        tStableMs: now,
        tConfidence: t.confidence,
        stale: this.stale,
        source: "meet_caption",
      });
      t.emittedText = t.text;
      t.lastEmitMs = now;
    }
    return events;
  }
}

// ---------------------------------------------------------------------------------------------
// The helper, as the rest of this file sees it
// ---------------------------------------------------------------------------------------------

/**
 * `found:false`: no browser window's ACTIVE tab is this meeting (the user switched tabs - Meet
 * then shows an auto picture-in-picture window, `pipWindow`, which exposes no captions and is
 * never read - or the tab is gone). `minimized`: the window holding the tab is minimized.
 */
export type MeetTabSnapshot =
  | { found: false; pipWindow?: boolean }
  | { found: true; root: UiaNode; readMs?: number; minimized?: boolean };

export interface MeetCaptionSensorLike {
  snapshot(meetCode: string): Promise<MeetTabSnapshot>;
  /** Invokes the one Button matching `target` exactly; the helper re-checks the label first. */
  invoke(meetCode: string, target: CaptionButtonTarget): Promise<{ invoked: boolean; reason?: string }>;
}

export const MEET_CODE = /^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/;

// ---------------------------------------------------------------------------------------------
// ensureCaptionsOn
// ---------------------------------------------------------------------------------------------

export interface EnsureOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  pollMs?: number;
  /** Extra reads when the tree looks empty: Chrome's accessibility tree can be cold at first. */
  wakeRetries?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Turns Meet's CC on if, and only if, the real CC button is identified and says captions are off.
 * Invokes at most once; then verifies within `verifyTimeoutMs` that the button now reads "turn
 * off captions" AND a captions region exists. No blind retry: on failure the UI asks the host.
 */
export async function ensureCaptionsOn(
  sensor: MeetCaptionSensorLike,
  meetCode: string,
  options: EnsureOptions = {},
): Promise<EnsureMeetCaptionsResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 3000;
  const pollMs = options.pollMs ?? 300;
  const wakeRetries = options.wakeRetries ?? 2;

  if (!MEET_CODE.test(meetCode)) return { ok: false, state: "unknown", reason: "invalid-meet-code" };

  let identified: CaptionButtonIdentification | null = null;
  for (let attempt = 0; attempt <= wakeRetries; attempt++) {
    if (attempt > 0) await sleep(500);
    const snap = await sensor.snapshot(meetCode);
    if (!snap.found) {
      identified = null;
      continue;
    }
    identified = identifyCaptionButton(snap.root);
    if (identified.ok || identified.reason !== "call-controls-not-found") break;
  }
  if (identified === null) return { ok: false, state: "unknown", reason: "meet-tab-not-found" };
  if (!identified.ok) return { ok: false, state: "unknown", reason: identified.reason };
  if (identified.state === "on") return { ok: true, state: "on" };

  const invoked = await sensor.invoke(meetCode, identified.target);
  if (!invoked.invoked) return { ok: false, state: "off", reason: `invoke-failed:${invoked.reason ?? "unknown"}` };

  const deadline = now() + verifyTimeoutMs;
  let lastState: "on" | "off" | "unknown" = "off";
  let buttonFlipped = false;
  while (now() < deadline) {
    await sleep(pollMs);
    const snap = await sensor.snapshot(meetCode);
    if (!snap.found) continue;
    const check = identifyCaptionButton(snap.root);
    lastState = check.ok ? check.state : "unknown";
    buttonFlipped = check.ok && check.state === "on";
    if (buttonFlipped && findCaptionsRegion(snap.root)) return { ok: true, state: "on" };
  }
  return {
    ok: false,
    state: lastState,
    reason: buttonFlipped ? "verify-no-captions-region" : "verify-button-not-flipped",
  };
}

/** One in-flight call per key: a second Start while CC is being turned on must not invoke again (that would turn it off). */
export function singleFlight<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key: string) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fn(key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

// ---------------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------------

export interface MeetCaptionStreamOptions {
  sensor: MeetCaptionSensorLike;
  emit: (event: MeetCaptionEvent) => void;
  emitStatus?: (status: MeetCaptionStatus) => void;
  /** Whether Meet audio is being captured; with it, a silent tree for `staleMs` is `stale`. */
  audioActive?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  staleMs?: number;
  stableMs?: number;
  /** Interim emission of a growing block (CaptionTrackerOptions.interimMs). Default 700 ms; 0 = off. */
  interimMs?: number;
  /**
   * Called about once per `summaryMs` (default 60 s) while the stream runs, and once on stop, with
   * counts only - never caption text or speaker names (main-log's rule). For main.log, so a test
   * call shows whether names were read at all.
   */
  onSummary?: (summary: MeetCaptionStreamSummary) => void;
  summaryMs?: number;
  /** Timer seam for tests; defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the stream did since the previous summary. Counts only. */
export interface MeetCaptionStreamSummary {
  meetCode: string;
  state: MeetCaptionStatus["state"];
  captionsVisible: boolean;
  /** Reads of the tab in this period, and how many of them showed the captions region. */
  reads: number;
  readsWithCaptions: number;
  /** Events emitted (each one a speaker-name hint), and how many distinct speakers they named. */
  events: number;
  speakers: number;
  /**
   * Why `events` can be 0 while captions were read. Of the reads with captions: how many showed
   * only the local user's own blocks ("Bạn" / "You", never emitted by design) and how many showed
   * a block of somebody else; and how many distinct other speakers the parser found. Alone in the
   * call = `selfOnlyReads == readsWithCaptions`, `otherSpeakers 0`: nothing to name, not a failure.
   * `otherSpeakers > 0` with `events 0` is a tracker/emission fault; `readsWithOthers 0` while
   * Meet-side people spoke is a parse fault (their header taken for self or for a text line).
   */
  selfOnlyReads: number;
  readsWithOthers: number;
  otherSpeakers: number;
  periodMs: number;
}

/** Default throttle for interim emissions of a growing caption block. */
export const MEET_CAPTION_INTERIM_MS = 700;

/**
 * Reads the Meet tab every `intervalMs` (350 ms) while enabled. Reads never overlap: the next one
 * is scheduled when the previous finished, so a slow read stretches the interval rather than
 * queueing. The clock is ours; the helper only answers "look now".
 */
export class MeetCaptionStream {
  private readonly options: MeetCaptionStreamOptions;
  private meetCode: string | null = null;
  private tracker: CaptionTracker | null = null;
  private known = new Set<string>();
  private spoken: SpokenLines = new Map();
  private timer: unknown = null;
  private generation = 0;
  private lastStatusKey = "";
  private lastState: MeetCaptionStatus["state"] = "unavailable_tab_inactive";
  private lastCaptionsVisible = false;
  private period = MeetCaptionStream.emptyPeriod(0);

  constructor(options: MeetCaptionStreamOptions) {
    this.options = options;
  }

  get activeMeetCode(): string | null {
    return this.meetCode;
  }

  start(meetCode: string): void {
    if (!MEET_CODE.test(meetCode)) return;
    if (this.meetCode === meetCode) return;
    this.stop();
    this.meetCode = meetCode;
    this.tracker = new CaptionTracker({
      meetCode,
      stableMs: this.options.stableMs,
      interimMs: this.options.interimMs ?? MEET_CAPTION_INTERIM_MS,
    });
    this.known = new Set();
    this.spoken = new Map();
    this.resetPeriod(this.now());
    const generation = ++this.generation;
    this.schedule(generation, 0);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) (this.options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    if (this.tracker && this.meetCode) {
      for (const event of this.tracker.flush(this.now())) this.emitEvent(event);
      this.summarize(this.now(), true);
      this.status({
        meetCode: this.meetCode,
        running: false,
        state: "unavailable_tab_inactive",
        captionsVisible: false,
        lastChangeMs: this.tracker.lastChangeMs,
      });
    }
    this.tracker = null;
    this.meetCode = null;
    this.lastStatusKey = "";
  }

  private now(): number {
    return (this.options.now ?? alignedNow)();
  }

  private emitEvent(event: MeetCaptionEvent): void {
    this.period.events++;
    this.period.speakers.add(event.speaker);
    this.options.emit(event);
  }

  private static emptyPeriod(startMs: number) {
    return {
      startMs,
      reads: 0,
      readsWithCaptions: 0,
      selfOnlyReads: 0,
      readsWithOthers: 0,
      events: 0,
      speakers: new Set<string>(),
      otherSpeakers: new Set<string>(),
    };
  }

  private resetPeriod(now: number): void {
    this.period = MeetCaptionStream.emptyPeriod(now);
  }

  private summarize(now: number, force: boolean): void {
    if (!this.meetCode || !this.options.onSummary) return;
    const periodMs = now - this.period.startMs;
    if (!force && periodMs < (this.options.summaryMs ?? 60_000)) return;
    const p = this.period;
    this.options.onSummary({
      meetCode: this.meetCode,
      state: this.lastState,
      captionsVisible: this.lastCaptionsVisible,
      reads: p.reads,
      readsWithCaptions: p.readsWithCaptions,
      events: p.events,
      speakers: p.speakers.size,
      selfOnlyReads: p.selfOnlyReads,
      readsWithOthers: p.readsWithOthers,
      otherSpeakers: p.otherSpeakers.size,
      periodMs,
    });
    this.resetPeriod(now);
  }

  private schedule(generation: number, delay: number): void {
    const set = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => void this.tick(generation), delay);
  }

  /** One read. Exposed for tests, which drive it without timers. */
  async tick(generation = this.generation): Promise<void> {
    const meetCode = this.meetCode;
    const tracker = this.tracker;
    if (!meetCode || !tracker || generation !== this.generation) return;
    let state: MeetCaptionStatus["state"] = "live";
    let captionsVisible = false;
    let error: string | undefined;
    try {
      const snap = await this.options.sensor.snapshot(meetCode);
      if (generation !== this.generation) return;
      const now = this.now();
      let blocks: CaptionBlock[] | null = null;
      if (!snap.found) state = "unavailable_tab_inactive";
      else {
        if (snap.minimized) state = "unavailable_minimized";
        blocks = readCaptions(snap.root, this.known, this.spoken).blocks;
        captionsVisible = blocks !== null;
      }
      this.period.reads++;
      if (blocks !== null) {
        this.period.readsWithCaptions++;
        const others = blocks.filter((b) => !b.isSelf && b.text);
        if (others.length > 0) this.period.readsWithOthers++;
        else if (blocks.some((b) => b.isSelf)) this.period.selfOnlyReads++;
        for (const b of others) this.period.otherSpeakers.add(b.speaker);
      }
      for (const event of tracker.ingest(now, blocks)) this.emitEvent(event);
    } catch (e) {
      if (generation !== this.generation) return;
      state = "unavailable_tab_inactive";
      error = e instanceof Error ? e.message : String(e);
    }
    const now = this.now();
    const quietFor = tracker.lastChangeMs === null ? Infinity : now - tracker.lastChangeMs;
    if (state === "live" && captionsVisible && (this.options.audioActive?.() ?? false) && quietFor > (this.options.staleMs ?? 8000)) {
      state = "stale";
    }
    if (state !== "live") tracker.markGap(state === "stale" ? "stale" : "unavailable");
    tracker.stale = state !== "live";
    this.status({ meetCode, running: true, state, captionsVisible, lastChangeMs: tracker.lastChangeMs, error });
    this.lastState = state;
    this.lastCaptionsVisible = captionsVisible;
    this.summarize(now, false);
    // Unavailable: slower, but never stopped - a read is also what keeps Chrome's accessibility
    // tree awake (Chrome turns it off after ~30 s without accessibility calls during input).
    // TODO(meet-captions): a UIA StructureChanged/TextChanged subscription on the captions group
    // as a fast path, keeping this poll as safety net and keep-alive.
    // A miss scans every browser window (measured ~2 s with several Chrome windows), hence 2 s.
    const delay = state.startsWith("unavailable") ? 2000 : (this.options.intervalMs ?? 350);
    if (generation === this.generation) this.schedule(generation, delay);
  }

  private status(status: MeetCaptionStatus): void {
    const key = `${status.meetCode}|${status.running}|${status.state}|${status.captionsVisible}|${status.error ?? ""}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.options.emitStatus?.(status);
  }
}

/**
 * `bridgeMeetCaptionNames`: env WARPTALK_BRIDGE_MEET_CAPTION_NAMES = 1/true/on or 0/false/off;
 * unset means ON, in dev and in packaged builds alike (turned on for production 2026-10-02).
 * 0/false/off/no stays the kill switch. `isPackaged` is kept so the call sites and a future
 * per-build default do not have to change.
 */
export function meetCaptionNamesEnabled(envValue: string | undefined, isPackaged: boolean): boolean {
  const v = (envValue ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  void isPackaged;
  return true;
}

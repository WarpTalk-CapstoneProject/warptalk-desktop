import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CaptionTracker,
  MeetCaptionStream,
  captionTexts,
  childrenOf,
  ensureCaptionsOn,
  findCallControls,
  findCaptionsRegion,
  identifyCaptionButton,
  meetCaptionNamesEnabled,
  parseCaptionTexts,
  readCaptions,
  singleFlight,
  textsRelated,
  tileNames,
  treeFromFlat,
} from "../meet-captions.ts";
import { MEET_VOCAB, captionStateFromLabel, normalizeLabel } from "../meet-caption-vocab.ts";

/**
 * Every tree here is either a REAL control-view dump of a live Meet tab (Chrome 154, vi UI, with
 * Tactiq, Fathom and a ChatGPT sidebar extension installed) or a deep clone of one with targeted
 * edits, so the identification rules are held against the shape Meet and extensions really emit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8").replace(/^﻿/, ""));
const ON = load("meet-tree-vi-captions-on.json");
const MULTI = load("meet-tree-vi-captions-multi.json");
const clone = (tree) => structuredClone(tree);

function find(root, match) {
  if (match(root)) return root;
  for (const child of childrenOf(root)) {
    const hit = find(child, match);
    if (hit) return hit;
  }
  return null;
}
function parentOf(root, target) {
  return find(root, (n) => childrenOf(n).includes(target));
}
function remove(root, match) {
  const node = find(root, match);
  assert.ok(node, "fixture edit: node to remove not found");
  const parent = parentOf(root, node);
  parent.children = childrenOf(parent).filter((c) => c !== node);
  return node;
}
const byName = (type, name) => (n) => n.type === type && n.name === name;
const callControls = (root) => find(root, byName("Group", "Kiểm soát cuộc gọi"));
const ccButton = (root) => find(root, (n) => n.type === "Button" && /phụ đề$/.test(n.name) && n.className?.startsWith("VYBDae"));

const TAILWIND = "min-h-[50px] cursor-pointer bg-transparent rounded-md box-content flex flex-col items-center";

/** Captions OFF: the button says "turn on", and the region and its settings cluster are gone. */
function captionsOff(tree = ON) {
  const t = clone(tree);
  ccButton(t).name = "Bật phụ đề";
  remove(t, byName("Group", "Phụ đề"));
  remove(t, byName("ComboBox", "Ngôn ngữ trong cuộc họp"));
  for (const name of ["Cỡ chữ", "Màu phông chữ", "Mở phần cài đặt phụ đề"]) remove(t, byName("Button", name));
  return t;
}

/** The same tree as Meet renders it in English. */
function english(tree = ON) {
  const t = clone(tree);
  const rename = { "Kiểm soát cuộc gọi": "Call controls", "Phụ đề": "Captions", "Tắt phụ đề": "Turn off captions (c)", "Bật phụ đề": "Turn on captions (c)", "Bạn": "You", "Rời khỏi cuộc gọi": "Leave call", "Tắt micrô": "Turn off microphone (ctrl + d)" };
  (function visit(n) {
    if (rename[n.name]) n.name = rename[n.name];
    childrenOf(n).forEach(visit);
  })(t);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------------------------

test("real tree, captions on: Meet's own CC button is found and reads ON", () => {
  const id = identifyCaptionButton(ON);
  assert.equal(id.ok, true);
  assert.equal(id.state, "on");
  assert.equal(id.target.name, "Tắt phụ đề");
  assert.equal(id.target.groupName, "Kiểm soát cuộc gọi");
  assert.match(id.target.className, /^VYBDae-Bz112c-LgbsSe /);
  assert.deepEqual(id.locales, ["vi"]);
  assert.equal(findCaptionsRegion(ON)?.name, "Phụ đề");
});

test("the real tree's extension buttons are never the CC button (Tactiq, Fathom)", () => {
  // Tactiq's "Toggle captions visibility" lives in its own group; Fathom injects a Group INSIDE
  // Meet's call controls. Neither may be the answer, and the Tactiq group (5 same-family buttons)
  // must not pass for the call controls.
  const found = findCallControls(ON);
  assert.equal(found.ok, true);
  assert.equal(found.controls.group.name, "Kiểm soát cuộc gọi");
  assert.equal(found.controls.family, "VYBDae-Bz112c-LgbsSe");
});

test("captions OFF: state off, no captions region", () => {
  const t = captionsOff();
  const id = identifyCaptionButton(t);
  assert.equal(id.ok, true);
  assert.equal(id.state, "off");
  assert.equal(id.target.name, "Bật phụ đề");
  assert.equal(findCaptionsRegion(t), null);
});

test("English UI: labels with a (c) shortcut hint, Captions region, You as self", () => {
  const t = english();
  const id = identifyCaptionButton(t);
  assert.equal(id.ok, true);
  assert.equal(id.state, "on");
  assert.deepEqual(id.locales, ["en"]);
  assert.equal(findCaptionsRegion(t)?.name, "Captions");
  assert.deepEqual(readCaptions(t).blocks, [{ speaker: "You", text: "Alo hôm nay là ngày.", isSelf: true }]);

  const off = english(captionsOff());
  assert.equal(identifyCaptionButton(off).state, "off");
});

test("a fake 'Turn on captions' outside the call controls, with Tailwind classes, is ignored", () => {
  const t = english(captionsOff());
  const tactiq = find(t, (n) => n.automationId === "tactiq-content-div");
  tactiq.children.push({ type: "Button", name: "Turn on captions", className: TAILWIND, patterns: ["Invoke"], children: [] });
  // ... and one wearing Meet's own class family but outside the group.
  const sideGroup = find(t, (n) => n.type === "Group" && n.className?.startsWith("tMdQNe"));
  sideGroup.children.push({ type: "Button", name: "Turn on captions", className: "VYBDae-Bz112c-LgbsSe hk9qKe", patterns: ["Invoke"], children: [] });
  const id = identifyCaptionButton(t);
  assert.equal(id.ok, true);
  assert.equal(id.target.groupName, "Call controls");
  assert.match(id.target.className, /^VYBDae-Bz112c-LgbsSe VYBDae/);
  assert.equal(id.target.className.includes("hk9qKe EXoIMe"), true);
});

test("an injected button INSIDE the call controls is rejected by class family", () => {
  const t = english(captionsOff());
  const group = find(t, byName("Group", "Call controls"));
  group.children.unshift({ type: "Button", name: "Turn on captions", className: TAILWIND, patterns: ["Invoke"], children: [] });
  group.children.unshift({ type: "Button", name: "Toggle captions visibility", className: TAILWIND, patterns: ["Invoke"], children: [] });
  const id = identifyCaptionButton(t);
  assert.equal(id.ok, true);
  assert.notEqual(id.target.className, TAILWIND);
});

test("if Meet's CC button is gone, an injected look-alike is still not chosen", () => {
  const t = english(captionsOff());
  remove(t, (n) => n.type === "Button" && n.name === "Turn on captions (c)");
  const group = find(t, byName("Group", "Call controls"));
  group.children.push({ type: "Button", name: "Turn on captions", className: TAILWIND, patterns: ["Invoke"], children: [] });
  const id = identifyCaptionButton(t);
  assert.deepEqual(id, { ok: false, reason: "cc-button-hidden" });
});

test("a same-family CC label without Invoke is not a candidate", () => {
  const t = clone(ON);
  ccButton(t).patterns = ["ScrollItem"];
  assert.deepEqual(identifyCaptionButton(t), { ok: false, reason: "cc-button-hidden" });
});

test("narrow window: CC folded into More options -> cc-button-hidden, nothing to invoke", () => {
  const t = captionsOff();
  remove(t, byName("Button", "Bật phụ đề"));
  assert.deepEqual(identifyCaptionButton(t), { ok: false, reason: "cc-button-hidden" });
});

test("unknown locale: no label matches -> unknown-locale, no action", () => {
  const t = clone(ON);
  (function visit(n) {
    if (n.name) n.name = `xx ${n.name.length}`;
    childrenOf(n).forEach(visit);
  })(t);
  const id = identifyCaptionButton(t);
  assert.deepEqual(id, { ok: false, reason: "unknown-locale" });
});

test("call controls found structurally when its name is not in the table", () => {
  const t = clone(ON);
  callControls(t).name = "Renamed by a Meet release";
  const id = identifyCaptionButton(t);
  assert.equal(id.ok, true);
  assert.equal(id.target.groupName, "Renamed by a Meet release");
  assert.equal(id.state, "on");
});

test("two groups claiming to be the call controls -> ambiguous, no action", () => {
  const t = clone(ON);
  const copy = clone(callControls(t));
  t.children.push(copy);
  assert.deepEqual(identifyCaptionButton(t), { ok: false, reason: "call-controls-ambiguous" });
});

test("captions region found structurally next to Meet's caption-settings cluster", () => {
  const t = clone(ON);
  find(t, byName("Group", "Phụ đề")).name = "";
  const region = findCaptionsRegion(t);
  assert.ok(region);
  assert.deepEqual(captionTexts(region), ["Bạn", "Alo hôm nay là ngày."]);
});

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

test("vocabulary: no label is both 'turn on' and 'turn off'; shortcut hints are stripped", () => {
  for (const [locale, v] of Object.entries(MEET_VOCAB)) {
    for (const on of v.turnOnCaptions) assert.equal(captionStateFromLabel(on)?.state, "off", `${locale}: ${on}`);
    for (const off of v.turnOffCaptions) assert.equal(captionStateFromLabel(off)?.state, "on", `${locale}: ${off}`);
  }
  assert.equal(normalizeLabel("  Turn on   captions (c) "), "turn on captions");
  assert.equal(captionStateFromLabel("Mở phần cài đặt phụ đề"), null);
  assert.equal(captionStateFromLabel("Toggle captions visibility"), null);
});

// ---------------------------------------------------------------------------------------------
// Parsing the region
// ---------------------------------------------------------------------------------------------

test("real multi-speaker tree: blocks split on tile names and the self label, lines joined", () => {
  const blocks = readCaptions(MULTI).blocks;
  assert.deepEqual(blocks.map((b) => b.speaker), [
    "Bạn", "16 Huỳnh Ngọc Kỳ", "Bạn", "16 Huỳnh Ngọc Kỳ", "Bạn", "16 Huỳnh Ngọc Kỳ",
  ]);
  assert.equal(blocks[1].text, "Ok đang đi kiếm kịch bản để nó lại có gì giờ là tao nói tiếng Việt hay nói tiếng Việt tiếng Việt cũng được");
  assert.equal(blocks[4].text, "Là sao? Tiếp tục đi Nói đi Nói tiếp đi.");
  assert.deepEqual(blocks.map((b) => b.isSelf), [true, false, true, false, true, false]);
  assert.ok(tileNames(MULTI, [findCaptionsRegion(MULTI)]).has("16 Huỳnh Ngọc Kỳ"));
});

test("without tiles, a repeated unpunctuated name still starts a block; a repeated sentence does not", () => {
  const texts = ["Daniel Park", "Ok.", "Sofia", "hi there", "Daniel Park", "Ok."];
  const blocks = parseCaptionTexts(texts);
  assert.deepEqual(blocks.map((b) => [b.speaker, b.text]), [
    ["Daniel Park", "Ok. Sofia hi there"],
    ["Daniel Park", "Ok."],
  ]);
  // Sofia is on a tile: now she is a header too.
  assert.deepEqual(parseCaptionTexts(texts, new Set(["Sofia"])).map((b) => b.speaker), ["Daniel Park", "Sofia", "Daniel Park"]);
});

/** A row of a transcript extension's panel, as dumped live from Tactiq: one Group, one Text. */
const extensionRow = (text) => ({
  type: "Group",
  name: "",
  className: "wrap-anywhere flex-1 px-2",
  children: [{ type: "Text", name: text, className: "" }],
});

test("an extension's transcript rows are not participant tiles", () => {
  const t = clone(MULTI);
  // Tactiq mirrors each caption line into its own panel, in the same document.
  t.children = [...childrenOf(t), extensionRow("lên là để xem bên Google"), extensionRow("Chào Hạnh Nhi Hạnh Nhi Hạnh Nhi")];
  const tiles = tileNames(t, [findCaptionsRegion(t)]);
  assert.ok(tiles.has("16 Huỳnh Ngọc Kỳ"));
  assert.ok(!tiles.has("lên là để xem bên Google"));
  assert.ok(!tiles.has("Chào Hạnh Nhi Hạnh Nhi Hạnh Nhi"));
  assert.deepEqual(readCaptions(t).blocks, readCaptions(MULTI).blocks);
});

test("a Meet tile holding a sentence is not a name", () => {
  const t = clone(MULTI);
  const tile = find(t, (n) => n.type === "Group" && childrenOf(n).length === 1 && childrenOf(n)[0].name === "16 Huỳnh Ngọc Kỳ");
  t.children = [...childrenOf(t), { ...clone(tile), children: [{ type: "Text", name: "Tôi tên là.", className: "" }] }];
  assert.ok(!tileNames(t, [findCaptionsRegion(t)]).has("Tôi tên là."));
});

test("a turn keeps the name it was first given: a spoken line never becomes a speaker", () => {
  const known = new Set(["mạnh trần nguyễn"]);
  const spoken = new Map();
  const first = parseCaptionTexts(["mạnh trần nguyễn", "Chào Hạnh Nhi Hạnh Nhi Hạnh Nhi", "Tôi tên là"], known, spoken);
  assert.deepEqual(first.map((b) => [b.speaker, b.text]), [["mạnh trần nguyễn", "Chào Hạnh Nhi Hạnh Nhi Hạnh Nhi Tôi tên là"]]);

  // Meet trimmed the head of the turn: the first Text is now one of its lines, not a name.
  const trimmed = parseCaptionTexts(["Tôi tên là", "Trần Mạnh Tuấn"], known, spoken);
  assert.deepEqual(trimmed.map((b) => [b.speaker, b.text, b.isSelf]), [["mạnh trần nguyễn", "Tôi tên là Trần Mạnh Tuấn", false]]);

  // Without the memory the old rule applies: the first Text names the block.
  assert.equal(parseCaptionTexts(["Tôi tên là", "Trần Mạnh Tuấn"], known)[0].speaker, "Tôi tên là");
});

test("a spoken line shown on a tile later does not split the turn; an accepted name still does", () => {
  const known = new Set();
  const spoken = new Map();
  const before = readCaptions(MULTI, known, spoken).blocks;
  assert.equal(spoken.get("lên là để xem bên Google"), "16 Huỳnh Ngọc Kỳ");
  assert.ok(!spoken.has("16 Huỳnh Ngọc Kỳ"), "a name is never remembered as speech");

  const t = clone(MULTI);
  const tile = find(t, (n) => n.type === "Group" && childrenOf(n).length === 1 && childrenOf(n)[0].name === "16 Huỳnh Ngọc Kỳ");
  t.children = [...childrenOf(t), { ...clone(tile), children: [{ type: "Text", name: "lên là để xem bên Google", className: "" }] }];
  assert.deepEqual(readCaptions(t, known, spoken).blocks, before);
  assert.ok(!known.has("lên là để xem bên Google"));
});

test("flat helper output rebuilds the same tree", () => {
  const flat = [
    { p: -1, t: "Document", n: "Meet", c: "", a: "RootWebArea", o: false, i: false },
    { p: 0, t: "Group", n: "Phụ đề", c: "x", a: "", o: false, i: false },
    { p: 1, t: "Text", n: "Bạn", c: "", a: "", o: false, i: false },
    { p: 0, t: "Button", n: "Tắt phụ đề", c: "y", a: "", o: false, i: true },
  ];
  const root = treeFromFlat(flat);
  assert.equal(root.type, "Document");
  assert.deepEqual(childrenOf(root).map((c) => c.name), ["Phụ đề", "Tắt phụ đề"]);
  assert.deepEqual(childrenOf(root)[1].patterns, ["Invoke"]);
  assert.equal(childrenOf(childrenOf(root)[0])[0].name, "Bạn");
});

// ---------------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------------

const B = (speaker, text, isSelf = false) => ({ speaker, text, isSelf });

test("multi-speaker sequence: Daniel -> Sofia -> You, with partial rewrites", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const events = [];
  const at = (t, blocks) => events.push(...tr.ingest(t, blocks));
  at(1000, []); // stream starts with an empty region
  at(1400, [B("Daniel", "Hello every")]);
  at(1800, [B("Daniel", "Hello everyone")]);
  at(2200, [B("Daniel", "Hello everyone, welcome")]);
  at(2600, [B("Daniel", "Hello everyone. Welcome.")]); // Meet rewrites the partial
  at(3000, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks")]);
  at(3400, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks Daniel.")]);
  at(3800, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks Daniel."), B("You", "Hi all", true)]);
  at(4200, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks Daniel."), B("You", "Hi all.", true)]);
  at(4700, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks Daniel."), B("You", "Hi all.", true)]);
  at(6000, [B("Daniel", "Hello everyone. Welcome."), B("Sofia", "Thanks Daniel."), B("You", "Hi all.", true)]);

  assert.deepEqual(events.map((e) => [e.kind, e.speaker, e.text]), [
    ["caption", "Daniel", "Hello everyone. Welcome."],
    ["caption", "Sofia", "Thanks Daniel."],
  ]);
  const [daniel, sofia] = events;
  assert.equal(daniel.tStartMs, 1400);
  assert.equal(daniel.tEndMs, 2600);
  assert.equal(daniel.tStableMs, 3800);
  assert.equal(daniel.tConfidence, "live");
  assert.equal(daniel.source, "meet_caption");
  assert.equal(sofia.tStartMs, 3000);
  assert.equal(sofia.tEndMs, 3400);
  assert.notEqual(daniel.blockId, sofia.blockId);
});

test("a block rewritten after it was emitted is an update with the same block id", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const events = [];
  const at = (t, blocks) => events.push(...tr.ingest(t, blocks));
  at(0, []);
  at(100, [B("Kỳ", "dòng Innova")]);
  at(1400, [B("Kỳ", "dòng Innova"), B("Bạn", "Khoan", true)]);
  at(1500, [B("Kỳ", "dòng Innova ok."), B("Bạn", "Khoan", true)]);
  at(2800, [B("Kỳ", "dòng Innova ok."), B("Bạn", "Khoan", true)]);
  at(2900, [B("Kỳ", "dòng Innova"), B("Bạn", "Khoan", true)]);
  at(4200, [B("Kỳ", "dòng Innova"), B("Bạn", "Khoan", true)]);
  at(9000, [B("Kỳ", "dòng Innova"), B("Bạn", "Khoan", true)]);
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [
    ["caption", "dòng Innova"],
    ["update", "dòng Innova ok."],
    ["update", "dòng Innova"],
  ]);
  assert.equal(new Set(events.map((e) => e.blockId)).size, 1);
});

test("Meet trimming its history shifts indices without re-announcing blocks", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const events = [];
  const at = (t, blocks) => events.push(...tr.ingest(t, blocks));
  at(0, []);
  at(100, [B("A", "one"), B("B", "two"), B("A", "three")]);
  at(2000, [B("A", "one"), B("B", "two"), B("A", "three")]);
  assert.equal(events.length, 3);
  at(2400, [B("B", "two"), B("A", "three"), B("B", "four")]);
  at(4000, [B("B", "two"), B("A", "three"), B("B", "four")]);
  assert.deepEqual(events.slice(3).map((e) => [e.kind, e.speaker, e.text]), [["caption", "B", "four"]]);
});

test("a region Meet rebuilt from scratch keeps identities of blocks already emitted", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const events = [];
  const at = (t, blocks) => events.push(...tr.ingest(t, blocks));
  at(0, []);
  at(100, [B("A", "one two three"), B("B", "four five")]);
  at(2000, [B("A", "one two three"), B("B", "four five")]);
  at(2400, [B("B", "four five"), B("C", "six")]);
  at(4000, [B("B", "four five"), B("C", "six")]);
  assert.deepEqual(events.map((e) => e.text), ["one two three", "four five", "six"]);
});

test("first read and big jumps are batches; self is never emitted", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const history = [B("Bạn", "Alo", true), B("Kỳ", "informational.")];
  const first = [...tr.ingest(0, history), ...tr.ingest(1300, history)];
  assert.deepEqual(first.map((e) => [e.speaker, e.tConfidence]), [["Kỳ", "batch"]]);

  const tr2 = new CaptionTracker({ meetCode: "abc-defg-hij" });
  tr2.ingest(0, []);
  tr2.ingest(400, [B("Kỳ", "chào")]);
  tr2.ingest(800, [B("Kỳ", "chào " + "x".repeat(400))]);
  const out = tr2.ingest(2100, [B("Kỳ", "chào " + "x".repeat(400))]);
  assert.equal(out[0].tConfidence, "batch");
});

test("REPLAY: 75 s of real 400 ms snapshots (two speakers, history, rewrites, a 55 s freeze)", () => {
  const log = readFileSync(path.join(here, "fixtures", "meet-captions-watch-vi-multi.log"), "utf8");
  const snapshots = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) read=\d+ms \| (.*)$/.exec(line);
    if (!m) continue;
    const t = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    const texts = m[5].split(" || ").map((s) => s.trim()).filter(Boolean);
    snapshots.push({ t, texts });
  }
  assert.ok(snapshots.length >= 15);

  // The tile names that the same call's tree showed (fixture meet-tree-vi-captions-multi.json).
  const known = tileNames(MULTI, [findCaptionsRegion(MULTI)]);
  const tr = new CaptionTracker({ meetCode: "ffo-iwfp-dgw" });
  const events = [];
  // The watcher logged only changes; between them the tree was read every 400 ms unchanged.
  let current = null;
  const end = snapshots[snapshots.length - 1].t + 3000;
  let next = 0;
  for (let t = snapshots[0].t; t <= end; t += 400) {
    while (next < snapshots.length && snapshots[next].t <= t) current = snapshots[next++];
    events.push(...tr.ingest(t, parseCaptionTexts(current.texts, known)));
  }

  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.speaker === "16 Huỳnh Ngọc Kỳ"), "only the remote speaker is emitted, never Bạn");
  assert.ok(events.every((e) => e.source === "meet_caption"));

  // History present at the first read is a batch, as is the burst after the freeze.
  const byBlock = new Map();
  for (const e of events) byBlock.set(e.blockId, [...(byBlock.get(e.blockId) ?? []), e]);
  const blocks = [...byBlock.values()];
  assert.equal(blocks.length, 3, "three remote blocks in the history");
  for (const evs of blocks) {
    assert.equal(evs[0].kind, "caption");
    assert.ok(evs.slice(1).every((e) => e.kind === "update"));
  }
  const long = blocks[2];
  const latest = long[long.length - 1];
  assert.equal(latest.tConfidence, "batch");
  assert.match(latest.text, /^Karaoke trong thời đại/, "the karaoke -> Karaoke rewrite is kept");
  assert.match(latest.text, /chào mọi người/, "the Chào -> chào rewrite is kept");
  assert.match(latest.text, /dòng Innova$/, "Innova ok. was rewritten back to Innova");
  // Meet showed "Innova ok." long enough to look final, then took it back: both are updates.
  assert.deepEqual(long.slice(-2).map((e) => e.text.slice(-10)), ["Innova ok.", "òng Innova"]);
  // No duplicates: one caption per block, updates only when the text changed.
  for (const evs of blocks) {
    for (let i = 1; i < evs.length; i++) assert.notEqual(evs[i].text, evs[i - 1].text);
  }
});

test("textsRelated tolerates Meet's rewrites, not unrelated text", () => {
  assert.ok(textsRelated("karaoke trong thời đại", "Karaoke trong thời đại số"));
  assert.ok(textsRelated("dòng Innova ok.", "dòng Innova"));
  assert.ok(!textsRelated("Hello there", "Completely different"));
});

// ---------------------------------------------------------------------------------------------
// ensureCaptionsOn
// ---------------------------------------------------------------------------------------------

function fakeSensor(trees, { invokeResult = { invoked: true }, afterInvoke = null } = {}) {
  let clock = 0;
  const sensor = {
    invokes: [],
    snapshots: 0,
    current: trees,
    async snapshot() {
      sensor.snapshots++;
      const tree = typeof sensor.current === "function" ? sensor.current() : sensor.current;
      return tree ? { found: true, root: tree } : { found: false };
    },
    async invoke(code, target) {
      sensor.invokes.push({ code, target });
      if (afterInvoke) sensor.current = afterInvoke;
      return invokeResult;
    },
  };
  const options = { now: () => clock, sleep: async (ms) => { clock += ms; } };
  return { sensor, options };
}

test("ensure: already on -> no invoke", async () => {
  const { sensor, options } = fakeSensor(ON);
  assert.deepEqual(await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options), { ok: true, state: "on" });
  assert.equal(sensor.invokes.length, 0);
});

test("ensure: off -> one invoke of Meet's button, verified by label flip and region", async () => {
  const { sensor, options } = fakeSensor(captionsOff(), { afterInvoke: ON });
  const result = await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options);
  assert.deepEqual(result, { ok: true, state: "on" });
  assert.equal(sensor.invokes.length, 1);
  assert.deepEqual(sensor.invokes[0].target, {
    name: "Bật phụ đề",
    className: ccButton(ON).className,
    groupName: "Kiểm soát cuộc gọi",
  });
});

test("ensure: label never flips -> ok:false within 3 s, and no second invoke", async () => {
  const { sensor, options } = fakeSensor(captionsOff());
  const result = await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options);
  assert.deepEqual(result, { ok: false, state: "off", reason: "verify-button-not-flipped" });
  assert.equal(sensor.invokes.length, 1);
});

test("ensure: label flips but no captions region -> ok:false", async () => {
  const flippedNoRegion = clone(ON);
  remove(flippedNoRegion, byName("Group", "Phụ đề"));
  remove(flippedNoRegion, byName("ComboBox", "Ngôn ngữ trong cuộc họp"));
  const { sensor, options } = fakeSensor(captionsOff(), { afterInvoke: flippedNoRegion });
  const result = await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verify-no-captions-region");
});

test("ensure: hidden button, unknown locale, injected-only and missing tab never invoke", async () => {
  const hidden = captionsOff();
  remove(hidden, byName("Button", "Bật phụ đề"));
  for (const [tree, reason] of [[hidden, "cc-button-hidden"], [null, "meet-tab-not-found"]]) {
    const { sensor, options } = fakeSensor(tree);
    const result = await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(sensor.invokes.length, 0);
  }
  const { sensor } = fakeSensor(ON);
  assert.equal((await ensureCaptionsOn(sensor, "not a code")).reason, "invalid-meet-code");
});

test("ensure: a cold tree is read again before giving up", async () => {
  let reads = 0;
  const { sensor, options } = fakeSensor(() => (++reads === 1 ? { type: "Document", name: "Meet", children: [] } : ON));
  assert.deepEqual(await ensureCaptionsOn(sensor, "ffo-iwfp-dgw", options), { ok: true, state: "on" });
});

test("ensure: concurrent Start presses invoke once (a second invoke would turn CC off)", async () => {
  const { sensor, options } = fakeSensor(captionsOff(), { afterInvoke: ON });
  const ensure = singleFlight((code) => ensureCaptionsOn(sensor, code, options));
  const [a, b] = await Promise.all([ensure("ffo-iwfp-dgw"), ensure("ffo-iwfp-dgw")]);
  assert.deepEqual(a, { ok: true, state: "on" });
  assert.deepEqual(b, a);
  assert.equal(sensor.invokes.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Stream + flag
// ---------------------------------------------------------------------------------------------

test("stream: sensor state live / tab inactive / minimized, and a batch after unavailability", async () => {
  let clock = 0;
  let snap = { found: true, root: clone(ON) };
  const events = [];
  const statuses = [];
  const stream = new MeetCaptionStream({
    sensor: { snapshot: async () => snap, invoke: async () => ({ invoked: false }) },
    emit: (e) => events.push(e),
    emitStatus: (s) => statuses.push(s),
    now: () => clock,
    audioActive: () => true,
    setTimer: () => null,
    clearTimer: () => {},
  });
  stream.start("ffo-iwfp-dgw");
  const tick = async (t) => {
    clock = t;
    await stream.tick();
  };
  await tick(0);
  assert.equal(statuses.at(-1).state, "live");
  assert.equal(statuses.at(-1).captionsVisible, true);

  snap = { found: false, pipWindow: true };
  await tick(400);
  assert.equal(statuses.at(-1).state, "unavailable_tab_inactive");

  snap = { found: true, root: clone(ON), minimized: true };
  await tick(800);
  assert.equal(statuses.at(-1).state, "unavailable_minimized");

  const withKy = clone(ON);
  const region = find(withKy, byName("Group", "Phụ đề"));
  // A name shown on a participant tile in this tree, so it starts a block.
  region.children.push({ type: "Text", name: "Hanh Nhi Ngo Xuan", children: [] }, { type: "Text", name: "short", children: [] });
  snap = { found: true, root: withKy };
  await tick(1200);
  assert.equal(statuses.at(-1).state, "live");
  await tick(2600);
  assert.equal(events.length, 1);
  assert.equal(events[0].tConfidence, "batch", "text that appeared while we could not look is a batch");

  await tick(20000);
  assert.equal(statuses.at(-1).state, "stale", "audio on, captions frozen for > 8 s");
  stream.stop();
  assert.equal(statuses.at(-1).running, false);
});

test("bridgeMeetCaptionNames flag: env wins, otherwise on in dev and in packaged builds", () => {
  assert.equal(meetCaptionNamesEnabled(undefined, false), true);
  assert.equal(meetCaptionNamesEnabled(undefined, true), true);
  assert.equal(meetCaptionNamesEnabled("", true), true);
  assert.equal(meetCaptionNamesEnabled("1", true), true);
  for (const off of ["0", "false", "off", "no", " OFF "]) {
    assert.equal(meetCaptionNamesEnabled(off, true), false, `kill switch ${JSON.stringify(off)} when packaged`);
    assert.equal(meetCaptionNamesEnabled(off, false), false, `kill switch ${JSON.stringify(off)} in dev`);
  }
});

// ---------------------------------------------------------------------------------------------
// Bug B3: names must reach the server WHILE a Meet speaker is still talking
// ---------------------------------------------------------------------------------------------

test("B3: with interimMs a growing block is named while it grows, not only after it stops", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij", interimMs: 700 });
  const events = [];
  const at = (t, blocks) => events.push(...tr.ingest(t, blocks));
  at(0, []);
  // One long turn: Meet keeps growing the same block for 3 s.
  at(400, [B("16 Huỳnh Ngọc Kỳ", "Xin")]);
  at(800, [B("16 Huỳnh Ngọc Kỳ", "Xin chào")]);
  at(1200, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi")]);
  at(1600, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi người")]);
  at(2000, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi người hôm")]);
  at(2400, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi người hôm nay")]);
  at(2800, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi người hôm nay"), B("Bạn", "Dạ", true)]);
  at(4100, [B("16 Huỳnh Ngọc Kỳ", "Xin chào mọi người hôm nay"), B("Bạn", "Dạ vâng", true)]);

  // First sighting at once, then at most every 700 ms while it grows; the stable pass adds nothing
  // when the text did not change since the last interim.
  assert.deepEqual(events.map((e) => [e.kind, e.tStartMs, e.tEndMs, e.tStableMs]), [
    ["caption", 400, 400, 400],
    ["update", 400, 1200, 1200],
    ["update", 400, 2000, 2000],
    ["update", 400, 2400, 2800],
  ]);
  assert.ok(events.every((e) => e.speaker === "16 Huỳnh Ngọc Kỳ"), "the Meet name, prefix and all");
  assert.equal(new Set(events.map((e) => e.blockId)).size, 1);
  // The local user ("Bạn" / "You") is never a Meet-side hint, interim or stable.
  assert.ok(!events.some((e) => e.speaker === "Bạn"));
});

test("B3: without interimMs the tracker still emits only stable blocks (unchanged default)", () => {
  const tr = new CaptionTracker({ meetCode: "abc-defg-hij" });
  const events = [];
  tr.ingest(0, []);
  events.push(...tr.ingest(400, [B("Lan", "Hello")]));
  events.push(...tr.ingest(800, [B("Lan", "Hello there")]));
  assert.equal(events.length, 0);
  events.push(...tr.ingest(2000, [B("Lan", "Hello there")]));
  assert.deepEqual(events.map((e) => e.text), ["Hello there"]);
});

test("B3: the stream emits interim names by default and summarises counts (no names) for main.log", async () => {
  let clock = 0;
  const withKy = clone(ON);
  const region = find(withKy, byName("Group", "Phụ đề"));
  region.children.push({ type: "Text", name: "Hanh Nhi Ngo Xuan", children: [] }, { type: "Text", name: "short", children: [] });
  const events = [];
  const summaries = [];
  const stream = new MeetCaptionStream({
    sensor: { snapshot: async () => ({ found: true, root: withKy }), invoke: async () => ({ invoked: false }) },
    emit: (e) => events.push(e),
    onSummary: (s) => summaries.push(s),
    summaryMs: 1000,
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  stream.start("ffo-iwfp-dgw");
  clock = 0;
  await stream.tick();
  assert.ok(events.length > 0, "a block is named on its first sighting, before it is stable");
  clock = 1100;
  await stream.tick();
  assert.equal(summaries.length, 1);
  const [s] = summaries;
  assert.equal(s.meetCode, "ffo-iwfp-dgw");
  assert.equal(s.state, "live");
  assert.equal(s.captionsVisible, true);
  assert.equal(s.reads, 2);
  assert.equal(s.readsWithCaptions, 2);
  assert.equal(s.events, events.length);
  assert.ok(s.speakers >= 1);
  assert.ok(!JSON.stringify(s).includes("Hanh"), "no speaker names in the log summary");
  stream.stop();
  assert.equal(summaries.length, 2, "a last summary on stop");
});

// Prod 2026-10-03 11:38 (v0.5.0, Meet jkm-bfek-dio, the user ALONE in the call): "reads":148,
// "readsWithCaptions":40, "events":0, "speakers":0. The same numbers come out of the real tree of a
// call where only the local user spoke: their blocks are headed "Bạn" and are never emitted. The
// summary now says so, so the next test call tells "nobody else spoke" from "names lost".
function summarizeOver(tree, reads) {
  let clock = 0;
  const events = [];
  const summaries = [];
  const stream = new MeetCaptionStream({
    sensor: { snapshot: async () => ({ found: true, root: tree }), invoke: async () => ({ invoked: false }) },
    emit: (e) => events.push(e),
    onSummary: (s) => summaries.push(s),
    summaryMs: 60_000,
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  stream.start("jkm-bfek-dio");
  return (async () => {
    for (let i = 0; i < reads; i++) {
      clock = i * 400;
      await stream.tick();
    }
    stream.stop();
    return { events, summary: summaries[summaries.length - 1] };
  })();
}

test("B3 prod 11:38: a call where only the local user spoke reads captions yet emits nothing (by design)", async () => {
  const { events, summary } = await summarizeOver(clone(ON), 5);
  assert.equal(events.length, 0, "self blocks (Bạn) are never emitted");
  assert.equal(summary.readsWithCaptions, 5);
  assert.equal(summary.events, 0);
  assert.equal(summary.speakers, 0);
  assert.equal(summary.selfOnlyReads, 5, "the summary says every captioned read was self-only");
  assert.equal(summary.readsWithOthers, 0);
  assert.equal(summary.otherSpeakers, 0);
});

test("B3: with a Meet-side speaker in the real tree, the summary counts them and names are emitted", async () => {
  const { events, summary } = await summarizeOver(clone(MULTI), 5);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.speaker === "16 Huỳnh Ngọc Kỳ"));
  assert.equal(summary.readsWithOthers, 5);
  assert.equal(summary.selfOnlyReads, 0);
  assert.equal(summary.otherSpeakers, 1);
  assert.equal(summary.speakers, 1);
  assert.ok(!JSON.stringify(summary).includes("Kỳ"), "counts only, no names in main.log");
});

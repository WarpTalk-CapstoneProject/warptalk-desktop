import test from "node:test";
import assert from "node:assert/strict";

import { MeetCaptionBuffer } from "../meet-caption-buffer.ts";

function caption(blockId, meetCode = "abc-defg-hij") {
  return {
    meetCode,
    blockId,
    kind: "caption",
    speaker: "Lan",
    text: `text ${blockId}`,
    tStartMs: 0,
    tEndMs: 0,
    tStableMs: 0,
    tConfidence: "live",
    stale: false,
    source: "meet_caption",
  };
}

function status(meetCode = "abc-defg-hij", state = "live") {
  return { meetCode, running: true, state, captionsVisible: true, lastChangeMs: null };
}

function harness() {
  let now = 1_000_000;
  const sent = [];
  const statuses = [];
  const buffer = new MeetCaptionBuffer({
    now: () => now,
    send: (event) => sent.push(event.blockId),
    sendStatus: (s) => statuses.push(s.state),
  });
  return { buffer, sent, statuses, advance: (ms) => (now += ms) };
}

test("passes events straight through while subscribed", () => {
  const { buffer, sent } = harness();
  buffer.subscribe("abc-defg-hij");
  buffer.event(caption("a"));
  assert.deepEqual(sent, ["a"]);
  assert.equal(buffer.pending.length, 0);
});

test("buffers while nobody is subscribed and flushes oldest first on subscribe", () => {
  const { buffer, sent, advance } = harness();
  buffer.event(caption("a"));
  advance(1000);
  buffer.event(caption("b"));
  advance(1000);
  buffer.event(caption("c"));
  assert.deepEqual(sent, []);
  buffer.subscribe("abc-defg-hij");
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.equal(buffer.pending.length, 0);
});

test("drops events older than 30 s, at flush time", () => {
  const { buffer, sent, advance } = harness();
  buffer.event(caption("old"));
  advance(20_000);
  buffer.event(caption("mid"));
  advance(10_001); // "old" is now 30.001 s old, "mid" 10 s
  buffer.subscribe("abc-defg-hij");
  assert.deepEqual(sent, ["mid"]);
});

test("a reload unsubscribes: events in between are kept and replayed to the new page", () => {
  const { buffer, sent } = harness();
  buffer.subscribe("abc-defg-hij");
  buffer.event(caption("a"));
  buffer.unsubscribe(); // did-start-navigation
  buffer.event(caption("b"));
  buffer.event(caption("c"));
  assert.deepEqual(sent, ["a"]);
  buffer.subscribe("abc-defg-hij"); // the reloaded page asks again
  assert.deepEqual(sent, ["a", "b", "c"]);
  // Not replayed twice.
  buffer.unsubscribe();
  buffer.subscribe("abc-defg-hij");
  assert.deepEqual(sent, ["a", "b", "c"]);
});

test("events of another meeting are not handed to a subscriber of this one", () => {
  const { buffer, sent } = harness();
  buffer.event(caption("other", "zzz-zzzz-zzz"));
  buffer.event(caption("mine"));
  buffer.subscribe("abc-defg-hij");
  assert.deepEqual(sent, ["mine"]);
});

test("only the latest status is replayed, before the events", () => {
  const order = [];
  const b = new MeetCaptionBuffer({
    now: () => 0,
    send: (e) => order.push(`event:${e.blockId}`),
    sendStatus: (s) => order.push(`status:${s.state}`),
  });
  b.status(status("abc-defg-hij", "unavailable_tab_inactive"));
  b.event(caption("a"));
  b.status(status("abc-defg-hij", "live"));
  b.subscribe("abc-defg-hij");
  assert.deepEqual(order, ["status:live", "event:a"]);
});

test("bounded by age even if nobody ever subscribes", () => {
  const { buffer, advance } = harness();
  for (let i = 0; i < 200; i++) {
    buffer.event(caption(String(i)));
    advance(1000);
  }
  // Only the last 30 s (events at t-30 s .. t-1 s) remain.
  assert.equal(buffer.pending.length, 30);
  assert.equal(buffer.pending[0].blockId, "170");
});

test("clear forgets events and status", () => {
  const { buffer, sent, statuses } = harness();
  buffer.status(status());
  buffer.event(caption("a"));
  buffer.clear();
  buffer.subscribe("abc-defg-hij");
  assert.deepEqual(sent, []);
  assert.deepEqual(statuses, []);
});

test("stamps sentAtMs at send time, live and replayed, without touching the buffered event", () => {
  let now = 5_000;
  const sent = [];
  const b = new MeetCaptionBuffer({ now: () => now, send: (e) => sent.push(e), sendStatus: () => {} });
  const early = caption("early");
  b.event(early); // read at 5000, nobody listening
  now += 12_000;
  b.subscribe("abc-defg-hij"); // replayed at 17000
  now += 500;
  b.event(caption("live")); // passed straight through at 17500
  assert.deepEqual(
    sent.map((e) => [e.blockId, e.sentAtMs]),
    [
      ["early", 17_000],
      ["live", 17_500],
    ],
  );
  assert.equal(early.sentAtMs, undefined, "the caller's object is not mutated");
  assert.equal(sent[0].tStartMs, 0, "capture times are left as they were");
});

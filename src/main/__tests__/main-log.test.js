import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createMainLog,
  formatLine,
  instrumentIpc,
  loggableUrl,
  MAX_LINE_CHARS,
  redact,
  rendererConsoleLevel,
  teeConsole,
} from "../main-log.ts";
import { trayMenuTemplate } from "../tray-menu.ts";

const AT = new Date("2026-10-02T10:21:27.431Z");

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warptalk-main-log-"));
  return path.join(dir, "main.log");
}

function lines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n");
}

/** A log that keeps its lines in memory, for the wrappers. */
function memoryLog() {
  const written = [];
  const at = (level) => (scope, message, data) => written.push({ level, scope, message, data });
  return { written, info: at("info"), warn: at("warn"), error: at("error"), flush() {}, file: "memory" };
}

test("a line is timestamp, level, scope, then the message and its data", () => {
  assert.equal(
    formatLine(AT, "info", "meet", "call state", { phase: "in-call" }),
    '2026-10-02T10:21:27.431Z [info] [meet] call state {"phase":"in-call"}',
  );
});

test("tokens, secrets, query strings and mailbox names never reach the line", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl";
  const text = redact(
    `jwt ${jwt} Bearer abcdefghijkl access_token=s3cr3tvalue ` +
      `https://app.warptalk.io.vn/desktop-login?code=abc#frag nhi@example.com`,
  );
  assert.ok(!text.includes(jwt));
  assert.ok(!text.includes("abcdefghijkl"));
  assert.ok(!text.includes("s3cr3tvalue"));
  assert.ok(!text.includes("code=abc"));
  assert.ok(!text.includes("nhi@"));
  assert.match(text, /https:\/\/app\.warptalk\.io\.vn\/desktop-login\?\[redacted\]/);
  assert.match(text, /\[email\]@example\.com/);
});

test("a Meet code stays: it is what ties a line to a call", () => {
  assert.equal(redact("presence abc-defg-hij"), "presence abc-defg-hij");
});

test("a multi-line stack stays one entry, and an oversized line is clipped", () => {
  const error = new Error("boom");
  const stacked = formatLine(AT, "error", "app", "uncaught exception", error);
  assert.equal(stacked.split("\n").slice(1).every((line) => line.startsWith("    ")), true);

  const huge = formatLine(AT, "info", "main", "x".repeat(MAX_LINE_CHARS * 2));
  assert.ok(huge.endsWith("… [clipped]"));
  assert.ok(huge.length < MAX_LINE_CHARS + 100);
});

test("the log appends to the file and counts a consecutive repeat instead of writing it", () => {
  const file = tempLog();
  const log = createMainLog(file, { now: () => AT });
  log.error("renderer", "main: socket closed");
  log.error("renderer", "main: socket closed");
  log.error("renderer", "main: socket closed");
  log.info("meet", "presence", { meetWindowVisible: true });
  log.flush();

  assert.deepEqual(lines(file), [
    "2026-10-02T10:21:27.431Z [error] [renderer] main: socket closed",
    "2026-10-02T10:21:27.431Z [info] [log] last line repeated 2 more time(s)",
    '2026-10-02T10:21:27.431Z [info] [meet] presence {"meetWindowVisible":true}',
  ]);
});

test("flush before quitting writes a pending repeat count", () => {
  const file = tempLog();
  const log = createMainLog(file, { now: () => AT });
  log.warn("main", "retrying");
  log.warn("main", "retrying");
  log.flush();
  assert.equal(lines(file).at(-1), "2026-10-02T10:21:27.431Z [info] [log] last line repeated 1 more time(s)");
});

test("past maxBytes main.log rolls to main.1.log, and only one older file is kept", () => {
  const file = tempLog();
  const older = file.replace(/\.log$/, ".1.log");
  const log = createMainLog(file, { now: () => AT, maxBytes: 200 });
  for (let i = 0; i < 12; i++) log.info("main", `line ${i}`);

  assert.ok(fs.existsSync(older));
  assert.ok(fs.statSync(file).size <= 200);
  assert.equal(lines(file).at(-1), "2026-10-02T10:21:27.431Z [info] [main] line 11");
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).sort(),
    ["main.1.log", "main.log"],
  );
});

test("an existing main.log is appended to, and its size counts toward the cap", () => {
  const file = tempLog();
  fs.writeFileSync(file, "x".repeat(190) + "\n");
  const log = createMainLog(file, { now: () => AT, maxBytes: 200 });
  log.info("app", "start");
  assert.equal(lines(file).length, 1);
  assert.ok(fs.readFileSync(file.replace(/\.log$/, ".1.log"), "utf8").startsWith("xxx"));
});

test("a log that cannot be written never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warptalk-main-log-"));
  // The "file" is a directory: every append fails.
  const log = createMainLog(dir, { now: () => AT });
  assert.doesNotThrow(() => {
    log.info("app", "start");
    log.flush();
  });
});

test("teeConsole keeps the console and copies to the log, leaving updater lines to their own file", () => {
  const forwarded = [];
  const target = {
    log: (...args) => forwarded.push(["log", ...args]),
    info: (...args) => forwarded.push(["info", ...args]),
    warn: (...args) => forwarded.push(["warn", ...args]),
    error: (...args) => forwarded.push(["error", ...args]),
  };
  const log = memoryLog();
  const undo = teeConsole(log, target);

  target.log("capture", { pid: 42 });
  target.warn("[updater] no update");
  target.error(new Error("bad"));
  undo();
  target.log("after undo");

  assert.equal(forwarded.length, 4);
  assert.deepEqual(
    log.written.map(({ level, scope }) => [level, scope]),
    [
      ["info", "main"],
      ["error", "main"],
    ],
  );
  assert.equal(log.written[0].message, 'capture {"pid":42}');
  assert.match(log.written[1].message, /^Error: bad/);
});

test("instrumentIpc logs a changing call with its shape, and any handler that throws", async () => {
  const handlers = new Map();
  const ipc = { handle: (channel, listener) => handlers.set(channel, listener) };
  const log = memoryLog();
  let t = 0;
  instrumentIpc(ipc, log, () => (t += 5));

  ipc.handle("bridge:activate-room", async (_event, roomId, options) => ({ ok: true, roomId, options }));
  ipc.handle("app:version", () => "0.4.10");
  ipc.handle("audio:get-devices", () => {
    throw new Error("no devices");
  });

  const result = await handlers.get("bridge:activate-room")({}, "room-1", { token: "x", ids: [1, 2] });
  assert.deepEqual(result, { ok: true, roomId: "room-1", options: { token: "x", ids: [1, 2] } });
  assert.equal(await handlers.get("app:version")({}), "0.4.10");
  await assert.rejects(() => handlers.get("audio:get-devices")({}), /no devices/);

  assert.deepEqual(log.written, [
    {
      level: "info",
      scope: "ipc",
      message: "bridge:activate-room",
      data: { args: ["room-1", { token: "x", ids: "[array]" }], ms: 5 },
    },
    {
      level: "error",
      scope: "ipc",
      message: "audio:get-devices threw",
      data: { args: [], ms: 5, error: "no devices" },
    },
  ]);
});

test("only the renderer's warnings and errors are kept, in either form Electron reports them", () => {
  assert.equal(rendererConsoleLevel(3), "error");
  assert.equal(rendererConsoleLevel("error"), "error");
  assert.equal(rendererConsoleLevel(2), "warn");
  assert.equal(rendererConsoleLevel("warning"), "warn");
  assert.equal(rendererConsoleLevel(1), null);
  assert.equal(rendererConsoleLevel("info"), null);
  assert.equal(rendererConsoleLevel(undefined), null);
});

test("a page address is logged without its query or fragment", () => {
  assert.equal(
    loggableUrl("https://app.warptalk.io.vn/ws/rooms/abc?token=x#y"),
    "https://app.warptalk.io.vn/ws/rooms/abc",
  );
  assert.equal(loggableUrl("not a url"), "not a url");
});

test("the tray's Open Logs Folder item opens the logs folder and does nothing else", () => {
  const calls = [];
  const template = trayMenuTemplate(
    "WarpTalk",
    { meetingPanelAvailable: false, updateLabel: null },
    {
      showApp: () => calls.push("showApp"),
      showMeetingPanel: () => calls.push("showMeetingPanel"),
      checkForUpdates: () => calls.push("checkForUpdates"),
      openLogs: () => calls.push("openLogs"),
      installUpdate: () => calls.push("installUpdate"),
      quit: () => calls.push("quit"),
    },
  );

  template.find((item) => item.label === "Open Logs Folder").click();
  assert.deepEqual(calls, ["openLogs"]);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeWindowsLoopbackSource,
  describeWindowsLoopbackSources,
  isLikelyMeetingWindow,
  parseDesktopSourceWindowHandle,
  readMainWindowHandleMap,
  resolveWindowOwnerProcessId,
} from "../windows-loopback-sources.ts";

/**
 * Stands in for the PowerShell spawn so these run on any platform. Records every script it was
 * handed, which is how the tests assert that the fast path never reaches for `Add-Type`.
 */
function fakePowerShell(replies) {
  const calls = [];
  const run = async (script, timeoutMs) => {
    calls.push({ script, timeoutMs });
    const reply = script.includes("Add-Type") ? replies.pinvoke : replies.handleMap;
    if (typeof reply === "function") return reply();
    return reply ?? null;
  };
  run.calls = calls;
  return run;
}

const usedAddType = (run) => run.calls.some((call) => call.script.includes("Add-Type"));

test("parses the window handle from an Electron desktop source id", () => {
  assert.equal(parseDesktopSourceWindowHandle("window:123456:0"), 123456);
  assert.equal(parseDesktopSourceWindowHandle("window:123456:1"), 123456);
});

test("rejects non-window or malformed desktop source ids", () => {
  assert.equal(parseDesktopSourceWindowHandle("screen:1:0"), null);
  assert.equal(parseDesktopSourceWindowHandle("window:0:0"), null);
  assert.equal(parseDesktopSourceWindowHandle("window:not-a-number:0"), null);
});

test("marks browser and Meet windows as likely meeting windows", () => {
  assert.equal(isLikelyMeetingWindow("Daily standup - Google Meet - Google Chrome"), true);
  assert.equal(isLikelyMeetingWindow("meet.google.com is sharing your screen"), true);
  assert.equal(isLikelyMeetingWindow("WarpTalk"), false);
});

test("describes a loopback source without treating the window handle as a pid", () => {
  const source = describeWindowsLoopbackSource(
    { id: "window:123456:0", name: "Daily standup - Google Meet - Google Chrome" },
    4242,
  );

  assert.deepEqual(source, {
    id: "window:123456:0",
    name: "Daily standup - Google Meet - Google Chrome",
    windowHandle: 123456,
    ownerProcessId: 4242,
    likelyMeetingWindow: true,
  });
});

test("describing a source never resolves a pid on its own", () => {
  const source = describeWindowsLoopbackSource({ id: "window:123456:0", name: "Chrome" });

  assert.equal(source.ownerProcessId, undefined);
  assert.equal(source.windowHandle, 123456);
});

test("reads the main window handle table and ignores unparsable lines", async () => {
  const run = fakePowerShell({ handleMap: "66390=1520\r\n\r\nnoise\r\n8=0\r\n0=77\r\n72=900\r\n" });

  const handles = await readMainWindowHandleMap(run);

  assert.deepEqual([...handles], [
    [66390, 1520],
    [72, 900],
  ]);
});

test("resolves a main window from Get-Process without compiling any C#", async () => {
  const run = fakePowerShell({ handleMap: "66390=1520\n" });

  assert.equal(await resolveWindowOwnerProcessId("window:66390:0", run), 1520);
  assert.equal(usedAddType(run), false);
});

test("falls back to P/Invoke for a window that is not its process's main one", async () => {
  const run = fakePowerShell({ handleMap: "66390=1520\n", pinvoke: "1520\r\n" });

  // The second Chrome window: same browser process, but absent from the MainWindowHandle table.
  assert.equal(await resolveWindowOwnerProcessId("window:77000:0", run), 1520);
  assert.equal(usedAddType(run), true);
});

test("fails closed rather than guessing a pid", async () => {
  const unresolvable = fakePowerShell({ handleMap: "66390=1520\n", pinvoke: "" });
  assert.equal(await resolveWindowOwnerProcessId("window:77000:0", unresolvable), null);

  const shellUnavailable = fakePowerShell({ handleMap: null, pinvoke: null });
  assert.equal(await resolveWindowOwnerProcessId("window:77000:0", shellUnavailable), null);

  const garbage = fakePowerShell({ handleMap: "66390=1520\n", pinvoke: "not-a-pid" });
  assert.equal(await resolveWindowOwnerProcessId("window:77000:0", garbage), null);

  const notAWindow = fakePowerShell({ handleMap: "66390=1520\n" });
  assert.equal(await resolveWindowOwnerProcessId("screen:1:0", notAWindow), null);
  assert.equal(notAWindow.calls.length, 0);
});

test("a shell that throws is a null pid, not a rejected promise", async () => {
  const run = fakePowerShell({
    handleMap: () => {
      throw new Error("powershell.exe is not on this machine");
    },
  });

  assert.equal(await resolveWindowOwnerProcessId("window:66390:0", run), null);
});

test("describes a whole picker list from one handle table read", async () => {
  const run = fakePowerShell({ handleMap: "66390=1520\n72=900\n" });

  const sources = await describeWindowsLoopbackSources(
    [
      { id: "window:66390:0", name: "Daily standup - Google Meet - Google Chrome" },
      { id: "window:77000:0", name: "Second window - Google Chrome" },
      { id: "screen:1:0", name: "Entire screen" },
    ],
    run,
  );

  assert.equal(run.calls.length, 1);
  assert.equal(usedAddType(run), false);
  assert.deepEqual(sources, [
    {
      id: "window:66390:0",
      name: "Daily standup - Google Meet - Google Chrome",
      windowHandle: 66390,
      ownerProcessId: 1520,
      likelyMeetingWindow: true,
    },
    {
      id: "window:77000:0",
      name: "Second window - Google Chrome",
      windowHandle: 77000,
      ownerProcessId: undefined,
      likelyMeetingWindow: true,
    },
    {
      id: "screen:1:0",
      name: "Entire screen",
      windowHandle: undefined,
      ownerProcessId: undefined,
      likelyMeetingWindow: false,
    },
  ]);
});

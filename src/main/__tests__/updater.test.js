import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FIRST_CHECK_DELAY_MS,
  RECHECK_INTERVAL_MS,
  RELEASES_PAGE_URL,
  interactiveCheckDialog,
  restartChoice,
  restartDialog,
  shouldPromptRestart,
  summarizeUpdateError,
  updaterGate,
} from "../update-policy.ts";
import { createUpdaterLogger } from "../updater-log.ts";
import { trayMenuTemplate } from "../tray-menu.ts";

const installed = { isPackaged: true, platform: "win32", env: {} };

test("an installed Windows build updates itself", () => {
  assert.deepEqual(updaterGate(installed), { enabled: true });
});

test("every build that cannot update itself says why", () => {
  const cases = [
    [{ ...installed, isPackaged: false }, "not-packaged"],
    [{ ...installed, env: { PORTABLE_EXECUTABLE_DIR: "D:\\Tools" } }, "portable"],
    [{ ...installed, platform: "darwin" }, "macos-unsigned"],
    [{ ...installed, platform: "linux" }, "linux"],
  ];
  for (const [environment, code] of cases) {
    const gate = updaterGate(environment);
    assert.equal(gate.enabled, false, code);
    assert.equal(gate.code, code);
    // The log line is the only evidence a gated updater leaves; an empty one looks like a bug.
    assert.ok(gate.reason.length > 0, `${code} logs no reason`);
    assert.ok(gate.userMessage.length > 0, `${code} tells the user nothing`);
  }
});

test("a dev run is gated before anything platform-specific", () => {
  // Otherwise `electron-vite dev` on a Mac would log the signing story instead of the real reason.
  const gate = updaterGate({ isPackaged: false, platform: "darwin", env: { PORTABLE_EXECUTABLE_DIR: "x" } });
  assert.equal(gate.code, "not-packaged");
});

test("the portable build is gated on Windows even though it is packaged", () => {
  // The NSIS installer electron-updater would run installs a second copy; it never replaces the
  // portable .exe the user is actually running.
  const gate = updaterGate({ ...installed, env: { PORTABLE_EXECUTABLE_DIR: "C:\\Users\\me\\Desktop" } });
  assert.equal(gate.code, "portable");
  assert.match(gate.reason, /PORTABLE_EXECUTABLE_DIR/);
});

test("a finished download asks once per version", () => {
  const base = { version: "0.5.0", lastPromptedVersion: null, dialogOpen: false, userAsked: false };
  assert.equal(shouldPromptRestart(base), true);

  // electron-updater re-emits update-downloaded for a cached build on every later check. After a
  // "Later", the six-hourly check must not bring the dialog back in the middle of a meeting.
  assert.equal(shouldPromptRestart({ ...base, lastPromptedVersion: "0.5.0" }), false);

  // A newer build than the one already declined is a new question.
  assert.equal(shouldPromptRestart({ ...base, lastPromptedVersion: "0.4.1" }), true);
});

test("the user asking from the tray always gets the restart dialog back", () => {
  assert.equal(
    shouldPromptRestart({ version: "0.5.0", lastPromptedVersion: "0.5.0", dialogOpen: false, userAsked: true }),
    true,
  );
});

test("never two restart dialogs at once", () => {
  assert.equal(
    shouldPromptRestart({ version: "0.5.0", lastPromptedVersion: null, dialogOpen: true, userAsked: true }),
    false,
  );
});

test("the restart dialog has two buttons, and dismissing it means Later", () => {
  const spec = restartDialog("WarpTalk", "0.5.0");
  assert.deepEqual(spec.buttons, ["Restart now", "Later"]);
  assert.match(spec.message, /0\.5\.0/);

  assert.equal(restartChoice(spec.buttons.indexOf("Restart now")), "restart");
  assert.equal(restartChoice(spec.buttons.indexOf("Later")), "later");
  // Escape / the close box resolve to cancelId. That must never quit a meeting.
  assert.equal(restartChoice(spec.cancelId), "later");
});

test("every updater dialog uses plain buttons, not Windows command links", () => {
  // Found in the packaged smoke test: without noLink, Windows drew "Restart now" and "Later" as two
  // full-width stacked tiles.
  const specs = [
    restartDialog("WarpTalk", "0.5.0"),
    interactiveCheckDialog("WarpTalk", { kind: "up-to-date", currentVersion: "0.4.2" }),
    interactiveCheckDialog("WarpTalk", { kind: "downloading", version: "0.5.0" }),
    interactiveCheckDialog("WarpTalk", { kind: "failed", error: "offline" }),
    interactiveCheckDialog("WarpTalk", { kind: "gated", gate: updaterGate({ ...installed, platform: "linux" }) }),
  ];
  for (const spec of specs) assert.equal(spec.noLink, true, spec.message);
});

test("the tray check answers even when there is nothing to do", () => {
  const upToDate = interactiveCheckDialog("WarpTalk", { kind: "up-to-date", currentVersion: "0.4.2" });
  assert.equal(upToDate.message, "WarpTalk is up to date (v0.4.2).");
  assert.equal(upToDate.openReleasesButton, null);

  const downloading = interactiveCheckDialog("WarpTalk", { kind: "downloading", version: "0.5.0" });
  assert.match(downloading.message, /0\.5\.0 is downloading/);
});

test("the tray check says why a gated build does not update, and where to go instead", () => {
  const mac = interactiveCheckDialog("WarpTalk", {
    kind: "gated",
    gate: updaterGate({ ...installed, platform: "darwin" }),
  });
  assert.match(mac.message, /macOS/);
  assert.equal(mac.buttons[mac.openReleasesButton], "Open download page");

  // A dev run has no download page worth sending anyone to.
  const dev = interactiveCheckDialog("WarpTalk", {
    kind: "gated",
    gate: updaterGate({ ...installed, isPackaged: false }),
  });
  assert.equal(dev.openReleasesButton, null);
  assert.deepEqual(dev.buttons, ["OK"]);
});

test("a failed tray check is reported, with a way forward", () => {
  const failed = interactiveCheckDialog("WarpTalk", { kind: "failed", error: "net::ERR_INTERNET_DISCONNECTED" });
  assert.equal(failed.type, "warning");
  assert.match(failed.detail, /ERR_INTERNET_DISCONNECTED/);
  assert.equal(failed.buttons[failed.openReleasesButton], "Open download page");
  assert.equal(failed.cancelId, 0, "dismissing must not open a browser");
});

test("update errors are logged as one line", () => {
  const error = new Error("HttpError: 403 Forbidden\n\"rate limit exceeded\"\n    at stack");
  assert.equal(summarizeUpdateError(error), "HttpError: 403 Forbidden");
  assert.equal(summarizeUpdateError("x".repeat(500)).length, 200);
});

test("the schedule: first check shortly after launch, then every six hours", () => {
  assert.equal(FIRST_CHECK_DELAY_MS, 30_000);
  assert.equal(RECHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.match(RELEASES_PAGE_URL, /^https:\/\/github\.com\/WarpTalk-CapstoneProject\/warptalk-desktop\/releases/);
});

test("the updater log is a file electron-updater can write to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-updater-log-"));
  try {
    const file = path.join(dir, "nested", "updater.log");
    const logger = createUpdaterLogger(file, { now: () => new Date("2026-09-11T00:00:00.000Z") });
    // electron-updater's Logger interface: info / warn / error, and an optional debug.
    for (const level of ["info", "warn", "error", "debug"]) assert.equal(typeof logger[level], "function");

    logger.info("Checking for update");
    logger.error(new Error("net::ERR_NAME_NOT_RESOLVED"));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines[0], "2026-09-11T00:00:00.000Z [info] Checking for update");
    assert.match(lines[1], /^2026-09-11T00:00:00\.000Z \[error\] Error: net::ERR_NAME_NOT_RESOLVED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the updater log starts over once it passes its size cap, and not before", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-updater-log-"));
  try {
    const file = path.join(dir, "updater.log");
    fs.writeFileSync(file, "x".repeat(50));
    createUpdaterLogger(file, { maxBytes: 100 }).info("kept");
    assert.match(fs.readFileSync(file, "utf8"), /^x{50}/, "a small log was thrown away");

    fs.writeFileSync(file, "x".repeat(150));
    createUpdaterLogger(file, { maxBytes: 100 }).info("fresh");
    assert.match(fs.readFileSync(file, "utf8"), /^\S+ \[info\] fresh\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tray offers Check for Updates…, and it calls the updater", () => {
  const calls = [];
  const template = trayMenuTemplate(
    "WarpTalk",
    { meetingPanelAvailable: false },
    {
      showApp: () => {},
      showMeetingPanel: () => {},
      checkForUpdates: () => calls.push("check"),
      quit: () => calls.push("quit"),
    },
  );
  const item = template.find((entry) => entry.label === "Check for Updates…");
  assert.ok(item, "no Check for Updates… entry in the tray");
  item.click();
  assert.deepEqual(calls, ["check"]);
});

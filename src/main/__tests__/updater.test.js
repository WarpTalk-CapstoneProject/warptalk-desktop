import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FIRST_CHECK_DELAY_MS,
  LATER_SNOOZE_MS,
  NO_DISMISSAL,
  RECHECK_INTERVAL_MS,
  RELEASES_PAGE_URL,
  RETRY_AFTER_ERROR_MS,
  STALE_CHECK_MS,
  dismissAfter,
  interactiveCheckDialog,
  nextCheckDelay,
  parseCardAction,
  releaseNotesUrl,
  restartChoice,
  restartDialog,
  shouldCheckNow,
  summarizeUpdateError,
  toastFor,
  trayBadged,
  trayTooltip,
  trayUpdateLabel,
  updateCardModel,
  updaterGate,
} from "../update-policy.ts";
import { withUpdateDot } from "../tray-badge.ts";
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

test("the macOS gate logs the line WT-618's acceptance table looks for", () => {
  // updater.ts logs "Auto-update skipped: <reason>"; the ticket expects "skipped: unsigned build".
  assert.match(updaterGate({ ...installed, platform: "darwin" }).reason, /^unsigned build/);
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

test("the schedule: first check shortly after launch, then hourly, sooner after a failure", () => {
  assert.equal(FIRST_CHECK_DELAY_MS, 10_000);
  assert.equal(RECHECK_INTERVAL_MS, 60 * 60 * 1000);
  assert.equal(nextCheckDelay(false), RECHECK_INTERVAL_MS);
  // One failed check used to mean six more hours without updates.
  assert.equal(nextCheckDelay(true), RETRY_AFTER_ERROR_MS);
  assert.ok(RETRY_AFTER_ERROR_MS <= 15 * 60 * 1000);
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
    { meetingPanelAvailable: false, updateLabel: null },
    {
      showApp: () => {},
      showMeetingPanel: () => {},
      checkForUpdates: () => calls.push("check"),
      installUpdate: () => calls.push("install"),
      quit: () => calls.push("quit"),
    },
  );
  const item = template.find((entry) => entry.label === "Check for Updates…");
  assert.ok(item, "no Check for Updates… entry in the tray");
  item.click();
  assert.deepEqual(calls, ["check"]);
});

// --- Telling the user: the update card, notifications, the tray ---

const T0 = Date.parse("2026-09-30T14:00:00Z");
const card = (phase, over = {}) =>
  updateCardModel({ appName: "WarpTalk", phase, dismissal: NO_DISMISSAL, now: T0, confirmingInstall: false, ...over });

test("a new version is announced when it is found, not when its download finishes", () => {
  // The bug this card exists for: nobody was told about 0.4.7, and it was installed by hand.
  const available = card({ kind: "available", version: "0.4.8" });
  assert.equal(available.title, "WarpTalk 0.4.8 is available");
  assert.deepEqual(available.buttons, [], "nothing to install yet");
  assert.equal(available.dismissible, true);
});

test("the download shows its progress", () => {
  const model = card({ kind: "downloading", version: "0.4.8", percent: 42.7, transferred: 49 * 1048576, total: 118 * 1048576 });
  assert.equal(model.progress, 42);
  assert.equal(model.detail, "42% · 49 of 118 MB");
  assert.equal(card({ kind: "downloading", version: "0.4.8", percent: 140, transferred: 0, total: 0 }).progress, 100);
});

test("a downloaded build offers Install and Later, and cannot be closed away", () => {
  const ready = card({ kind: "ready", version: "0.4.8" });
  assert.deepEqual(
    ready.buttons.map((b) => [b.action, b.label]),
    [["later", "Later"], ["install", "Install"]],
  );
  assert.equal(ready.buttons.find((b) => b.action === "install").style, "primary");
  assert.equal(ready.dismissible, false, "an X would be a Later with no way back");
});

test("Install during a meeting asks first, on the card", () => {
  const confirm = card({ kind: "ready", version: "0.4.8" }, { confirmingInstall: true });
  assert.match(confirm.title, /leave the meeting/);
  assert.deepEqual(confirm.buttons.map((b) => b.action), ["cancel-install", "confirm-install"]);
  assert.equal(confirm.buttons[1].style, "danger");
});

test("Later hides the card for four hours, for that version only", () => {
  const phase = { kind: "ready", version: "0.4.8" };
  const later = dismissAfter("later", phase, NO_DISMISSAL, T0);
  assert.equal(LATER_SNOOZE_MS, 4 * 60 * 60 * 1000);
  assert.equal(card(phase, { dismissal: later }), null);
  assert.equal(card(phase, { dismissal: later, now: T0 + LATER_SNOOZE_MS - 1 }), null);
  assert.ok(card(phase, { dismissal: later, now: T0 + LATER_SNOOZE_MS }), "the card comes back");
  // A newer build than the one put off is a new question.
  assert.ok(card({ kind: "ready", version: "0.4.9" }, { dismissal: later }));
});

test("closing the download card hides it until the build is ready", () => {
  const phase = { kind: "downloading", version: "0.4.8", percent: 10, transferred: 1, total: 10 };
  const closed = dismissAfter("dismiss", phase, NO_DISMISSAL, T0);
  assert.equal(card(phase, { dismissal: closed }), null);
  assert.equal(card({ kind: "available", version: "0.4.8" }, { dismissal: closed }), null);
  assert.ok(card({ kind: "ready", version: "0.4.8" }, { dismissal: closed }), "ready must still be said");
});

test("a portable copy is told about new versions and sent to the download page", () => {
  const manual = card({ kind: "manual", version: "0.4.8" });
  assert.deepEqual(manual.buttons.map((b) => b.action), ["download"]);
  assert.match(manual.detail, /portable/);
  assert.equal(card({ kind: "idle" }), null);
});

test("notifications: once per version and stage, only when the window is not in front", () => {
  const shown = new Set();
  const ready = { kind: "ready", version: "0.4.8" };
  assert.equal(toastFor({ phase: ready, alreadyShown: shown, windowInFront: true }), null, "the card is enough");
  const first = toastFor({ phase: ready, alreadyShown: shown, windowInFront: false });
  assert.deepEqual(first, { kind: "ready", key: "ready:0.4.8" });
  shown.add(first.key);
  // electron-updater re-emits update-downloaded for the cached build on every hourly check.
  assert.equal(toastFor({ phase: ready, alreadyShown: shown, windowInFront: false }), null);
  assert.ok(toastFor({ phase: { kind: "available", version: "0.4.8" }, alreadyShown: shown, windowInFront: false }));
  const downloading = { kind: "downloading", version: "0.4.8", percent: 1, transferred: 0, total: 0 };
  assert.equal(toastFor({ phase: downloading, alreadyShown: shown, windowInFront: false }), null);
});

test("waking the machine checks; showing the window checks only when the last check is stale", () => {
  const idle = { kind: "idle" };
  assert.equal(shouldCheckNow({ reason: "resume", phase: idle, lastCheckAt: T0, now: T0 + 1 }), true);
  assert.equal(shouldCheckNow({ reason: "unlock", phase: idle, lastCheckAt: T0, now: T0 + 1 }), true);
  assert.equal(shouldCheckNow({ reason: "window-shown", phase: idle, lastCheckAt: T0, now: T0 + STALE_CHECK_MS - 1 }), false);
  assert.equal(shouldCheckNow({ reason: "window-shown", phase: idle, lastCheckAt: T0, now: T0 + STALE_CHECK_MS }), true);
  assert.equal(shouldCheckNow({ reason: "window-shown", phase: idle, lastCheckAt: null, now: T0 }), true);
  for (const busy of [
    { kind: "downloading", version: "0.4.8", percent: 1, transferred: 0, total: 0 },
    { kind: "ready", version: "0.4.8" },
  ]) {
    assert.equal(shouldCheckNow({ reason: "resume", phase: busy, lastCheckAt: null, now: T0 }), false, busy.kind);
  }
});

test("the tray keeps a waiting update in view until it is installed", () => {
  const ready = { kind: "ready", version: "0.4.8" };
  assert.equal(trayUpdateLabel(ready), "Restart to update (0.4.8)");
  assert.equal(trayUpdateLabel({ kind: "available", version: "0.4.8" }), null);
  assert.match(trayTooltip("WarpTalk", ready), /0\.4\.8 is ready/);
  assert.equal(trayTooltip("WarpTalk", { kind: "idle" }), "WarpTalk");
  assert.equal(trayBadged(ready), true);
  assert.equal(trayBadged({ kind: "idle" }), false);

  const calls = [];
  const template = trayMenuTemplate(
    "WarpTalk",
    { meetingPanelAvailable: false, updateLabel: trayUpdateLabel(ready) },
    {
      showApp: () => {},
      showMeetingPanel: () => {},
      checkForUpdates: () => {},
      installUpdate: () => calls.push("install"),
      quit: () => {},
    },
  );
  assert.equal(template[0].label, "Restart to update (0.4.8)", "first, where it is seen");
  template[0].click();
  assert.deepEqual(calls, ["install"]);
});

test("the card acts only on its own buttons", () => {
  assert.equal(parseCardAction("warptalk-update:install"), "install");
  assert.equal(parseCardAction("warptalk-update:later"), "later");
  assert.equal(parseCardAction("warptalk-update:rm -rf"), null);
  assert.equal(parseCardAction("https://example.com/warptalk-update:install"), null);
  assert.equal(releaseNotesUrl("0.4.8"), "https://github.com/WarpTalk-CapstoneProject/warptalk-desktop/releases/tag/v0.4.8");
});

test("the tray dot is drawn in the corner and leaves the rest of the icon alone", () => {
  const size = 32;
  const icon = Buffer.alloc(size * size * 4, 0x40);
  const badged = withUpdateDot(icon, size, size);
  const px = (x, y) => [...badged.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  const r = Math.round(size * 0.22);
  assert.deepEqual(px(size - r, r - 1), [0x8a, 0xc3, 0x4c, 0xff], "green in the top-right");
  assert.deepEqual(px(2, size - 3), [0x40, 0x40, 0x40, 0x40], "bottom-left untouched");
  assert.equal(icon[((r - 1) * size + (size - r)) * 4], 0x40, "the source bitmap is not modified");
  assert.equal(withUpdateDot(Buffer.alloc(3), size, size).length, 3, "a bitmap of the wrong size is returned as is");
});

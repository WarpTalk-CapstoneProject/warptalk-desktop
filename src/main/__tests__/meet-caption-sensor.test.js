import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { CAPTION_SENSOR_SCRIPT } from "../meet-caption-sensor.ts";

/**
 * The helper runs against a live UI Automation tree no unit test can build; these hold its shape:
 * it parses, it survives PowerShell 5.1's ANSI read, and the invoke path keeps its gates.
 * The judgement itself (which button, which region) is in meet-captions.ts and tested there.
 */

test("the script is pure ASCII (PowerShell 5.1 reads a BOM-less script as ANSI)", () => {
  assert.doesNotMatch(CAPTION_SENSOR_SCRIPT, /[^\x00-\x7f]/);
  assert.doesNotMatch(CAPTION_SENSOR_SCRIPT, /`/, "a backtick would end the template literal early");
});

test("stdout is UTF-8 so Vietnamese names come back intact", () => {
  assert.match(CAPTION_SENSOR_SCRIPT, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding/);
});

test("the Meet tab is chosen by its exact URL, never by window title", () => {
  assert.match(CAPTION_SENSOR_SCRIPT, /\$u\.Host -ne 'meet\.google\.com'/);
  const find = CAPTION_SENSOR_SCRIPT.slice(CAPTION_SENSOR_SCRIPT.indexOf("function Find-MeetDoc"), CAPTION_SENSOR_SCRIPT.indexOf("function Test-PipWindow"));
  assert.doesNotMatch(find, /GetWindowText/, "a title is written by the page; it may only be a hint");
});

test("invoke requires one exact match and re-reads the live label before invoking", () => {
  const body = CAPTION_SENSOR_SCRIPT.slice(CAPTION_SENSOR_SCRIPT.indexOf("function Do-Invoke"), CAPTION_SENSOR_SCRIPT.indexOf("while ($true)"));
  const unique = body.indexOf("target-not-unique");
  const relabel = body.indexOf("label-changed");
  const invoke = body.indexOf(".Invoke()");
  assert.ok(unique !== -1 && relabel !== -1 && invoke !== -1);
  assert.ok(unique < invoke && relabel < invoke, "both gates must run before Invoke");
  assert.doesNotMatch(CAPTION_SENSOR_SCRIPT, /SetFocus|SendKeys|keybd_event|SendInput|SetForegroundWindow/);
  assert.equal((CAPTION_SENSOR_SCRIPT.match(/\.Invoke\(\)/g) ?? []).length, 1, "exactly one invoke site");
});

test("the sensor script parses", { skip: process.platform !== "win32" && "PowerShell is Windows-only here" }, () => {
  const probe = [
    "$errors = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors)",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", probe], {
    input: CAPTION_SENSOR_SCRIPT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `PowerShell parse errors:\n${result.stdout}${result.stderr}`);
});

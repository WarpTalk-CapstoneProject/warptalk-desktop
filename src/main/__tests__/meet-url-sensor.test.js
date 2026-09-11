import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { SENSOR_SCRIPT } from "../meet-url-sensor.ts";

/**
 * The sensor's decisions live in PowerShell against a live UI Automation tree, which no unit test
 * can build. So these hold the SHAPE of the decision - the gates, and the order they run in - and
 * the live behaviour is checked by hand on a real browser (see the PR). A gate deleted in a
 * refactor turns these red; a gate that exists but misjudges a real tree cannot, and is not
 * claimed to.
 */

/** The body of one PowerShell function, up to the next top-level function or loop. */
function functionBody(name) {
  const start = SENSOR_SCRIPT.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} is missing from the sensor script`);
  const rest = SENSOR_SCRIPT.slice(start + 1);
  const end = rest.search(/\n(?:function |while \(\$true\))/);
  return end === -1 ? rest : rest.slice(0, end);
}

test("a page with a real address that is not Meet ends the read for that window", () => {
  // The spoof reproduced on Chrome 152: any tab whose TEXT said meet.google.com was reported as a
  // call, because the label search ran after the address check failed.
  const body = functionBody("Read-Window");
  const httpBranch = body.slice(body.indexOf("'^https?://'"), body.indexOf("about:blank"));
  assert.match(httpBranch, /return \$null/, "an https page must not fall through to the label search");
});

test("the picture-in-picture label is only looked for in an about:blank window", () => {
  const body = functionBody("Read-Window");
  const gate = body.indexOf("$value -ne 'about:blank'");
  const search = body.indexOf("$hostLabelCond");
  assert.notEqual(gate, -1, "no about:blank gate before the PiP label search");
  assert.notEqual(search, -1, "the PiP label search is gone");
  assert.ok(gate < search, "the about:blank gate must run before the label search");
});

test("a label inside the page's own document is never taken for browser chrome", () => {
  const body = functionBody("Read-Window");
  assert.match(body, /Test-InDocument/, "the PiP branch no longer checks where the label sits");
  assert.match(body, /-not \(Test-InDocument/, "only a label OUTSIDE the Document may count");

  const inDocument = functionBody("Test-InDocument");
  assert.match(inDocument, /\$DOC_TYPE\.Id/, "Test-InDocument must stop at a Document ancestor");
  assert.match(inDocument, /Automation\]::Compare/, "Test-InDocument must stop at the window root");
});

test("no search of every Text element in the window survives", () => {
  // The old read: FindAll(Descendants, <any Text>) and a name compare in the loop. That is the
  // shape that read page content; the replacement asks for the host label by name.
  assert.doesNotMatch(SENSOR_SCRIPT, /\$textCond\b/);
});

test("the sensor script parses", { skip: process.platform !== "win32" && "PowerShell is Windows-only here" }, () => {
  // A syntax error would not show until the helper started on a user's machine, where the watcher
  // treats every failed read as "could not look" - i.e. the bridge would silently never trigger.
  const probe = [
    "$errors = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors)",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", probe], {
    input: SENSOR_SCRIPT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `PowerShell parse errors:\n${result.stdout}${result.stderr}`);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAC_BROWSERS,
  MAC_SENSOR_SCRIPT,
  meetCodeFromAddress,
  sightingFromReports,
} from "../meet-url-sensor-mac.ts";

/**
 * The Apple Events half runs against live browsers and a TCC prompt, which no unit test can build.
 * What is testable is everything after the answer comes back - what counts as a Meet call, and
 * whether a refusal can pass for "no call" - plus the one property of the script that would make
 * the feature hostile if it regressed: it must never launch a browser.
 */

test("a Meet call's address yields its room code", () => {
  assert.equal(meetCodeFromAddress("https://meet.google.com/jkq-yaax-phw?authuser=0"), "jkq-yaax-phw");
  assert.equal(meetCodeFromAddress("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
});

test("Meet's landing page and other Google pages are not a call", () => {
  assert.equal(meetCodeFromAddress("https://meet.google.com/"), null);
  assert.equal(meetCodeFromAddress("https://meet.google.com/landing"), null);
  assert.equal(meetCodeFromAddress("https://calendar.google.com/abc-defg-hij"), null);
});

test("an address that merely contains the Meet host is not Meet", () => {
  assert.equal(meetCodeFromAddress("https://meet.google.com.evil.com/abc-defg-hij"), null);
  assert.equal(meetCodeFromAddress("https://evil.com/meet.google.com/abc-defg-hij"), null);
  assert.equal(meetCodeFromAddress("https://evil.com/?next=https://meet.google.com/abc-defg-hij"), null);
  assert.equal(meetCodeFromAddress("not a url"), null);
});

test("the first Meet tab across browsers is the sighting", () => {
  const sighting = sightingFromReports([
    { name: "Safari", urls: ["https://example.com/"] },
    { name: "Google Chrome", urls: ["https://github.com/", "https://meet.google.com/jkq-yaax-phw"] },
  ]);
  assert.deepEqual(sighting, { meetCode: "jkq-yaax-phw", processId: null, via: "document" });
});

test("browsers that answered with no Meet tab mean no call", () => {
  assert.equal(sightingFromReports([{ name: "Google Chrome", urls: ["https://github.com/"] }]), null);
  assert.equal(sightingFromReports([]), null, "no running browser is an answer, not a failure");
});

test("a refusal with nothing else answering is 'could not look', never 'no call'", () => {
  assert.throws(
    () => sightingFromReports([{ name: "Google Chrome", error: "Not authorized to send Apple events" }]),
    /Google Chrome/,
  );
});

test("one browser refusing does not hide another browser's answer", () => {
  assert.equal(
    sightingFromReports([
      { name: "Safari", error: "Not authorized to send Apple events" },
      { name: "Google Chrome", urls: [] },
    ]),
    null,
  );
});

test("the script checks running() before it touches a browser's windows", () => {
  const running = MAC_SENSOR_SCRIPT.indexOf(".running()");
  const windows = MAC_SENSOR_SCRIPT.indexOf(".windows()");
  assert.notEqual(running, -1, "the running() guard is gone - the sensor would launch browsers");
  assert.ok(running < windows, "running() must be checked before windows() is read");
  assert.match(MAC_SENSOR_SCRIPT, /if \(!running\) continue;/);
});

test("every browser in the list is asked for its visible tab only", () => {
  for (const browser of MAC_BROWSERS) {
    assert.ok(["activeTab", "currentTab"].includes(browser.tab), `${browser.name} reads ${browser.tab}`);
  }
  assert.doesNotMatch(MAC_SENSOR_SCRIPT, /\.tabs\(\)/, "reading every tab would count background tabs as calls");
});

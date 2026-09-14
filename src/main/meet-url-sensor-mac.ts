/**
 * The macOS half of the Meet sensor: the browser's own address, asked for over Apple Events.
 *
 * The Windows sensor (meet-url-sensor.ts) reads the committed URL through UI Automation. macOS has
 * no equivalent a helper can read without Accessibility access, but every browser worth supporting
 * answers a scripting question about its own tabs - and that answer is the address, which the page
 * cannot write. The same trust boundary as on Windows, reached a different way.
 *
 * WHAT THE USER IS ASKED
 *   The first question to each browser raises macOS's own prompt: "WarpTalk wants access to control
 *   Google Chrome". That prompt IS the permission step - there is nothing to build on top of it, and
 *   nothing to do until it is answered. A refusal comes back as error -1743 on every later read,
 *   which is reported as "could not look" (a thrown read), never as "no Meet on screen".
 *
 * WHAT IT NEVER DOES
 *   Launch a browser. `Application(name)` alone does not start an app, but reading `windows()`
 *   does, so every browser is checked with `running()` first. A sensor that opened Safari every
 *   three seconds for a Chrome user would be the worst possible first impression of this feature.
 *
 * ONLY THE ACTIVE TAB
 *   Same rule as the Windows read, which sees each window's visible document: a Meet tab left
 *   behind in the background of a window is not a call the user is looking at. Switching away
 *   mid-call is covered by the web side's latch and grace, not by reading hidden tabs here.
 *
 * WHY A PROCESS PER READ
 *   `osascript` starts in roughly 100 ms, well inside the 3 s poll, and a one-shot process has no
 *   state to wedge. The Windows helper is long-lived only because PowerShell's UI Automation
 *   assemblies cost seconds to load; nothing here does.
 */

import { execFile } from "child_process";

import type { MeetSighting } from "./meet-url-sensor.ts";

/**
 * Browsers asked, by their scripting name, with how each one names a window's visible tab.
 *
 * Chromium browsers share Chrome's dictionary (`activeTab`); Safari names it `currentTab`. A browser
 * that is not installed makes `Application()` throw, which is caught per browser like any refusal.
 */
export const MAC_BROWSERS: ReadonlyArray<{ name: string; tab: "activeTab" | "currentTab" }> = [
  { name: "Google Chrome", tab: "activeTab" },
  { name: "Arc", tab: "activeTab" },
  { name: "Brave Browser", tab: "activeTab" },
  { name: "Microsoft Edge", tab: "activeTab" },
  { name: "Vivaldi", tab: "activeTab" },
  { name: "Chromium", tab: "activeTab" },
  { name: "Safari", tab: "currentTab" },
];

/**
 * JavaScript for Automation, printed as one JSON line.
 *
 * Per browser: `urls` when it answered, `error` when it was running and refused, absent when it
 * was not running. The decision about what those URLs mean is made in TypeScript below, where it
 * can be tested without a Mac.
 */
export const MAC_SENSOR_SCRIPT = `
const browsers = ${JSON.stringify(MAC_BROWSERS)};
const report = [];
for (const browser of browsers) {
  let app;
  try { app = Application(browser.name); } catch (e) { continue; }
  let running = false;
  try { running = app.running(); } catch (e) { running = false; }
  if (!running) continue;
  try {
    const urls = [];
    for (const win of app.windows()) {
      try {
        const tab = win[browser.tab]();
        const url = tab ? tab.url() : null;
        if (url) urls.push(String(url));
      } catch (e) {}
    }
    report.push({ name: browser.name, urls });
  } catch (e) {
    report.push({ name: browser.name, error: String(e && e.message ? e.message : e) });
  }
}
JSON.stringify(report);
`;

export interface MacBrowserReport {
  name: string;
  urls?: string[];
  error?: string;
}

/** Meet's room code as the whole path, the same shape the Windows sensor accepts. */
const MEET_CODE_PATH = /^\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})$/;

/** The Meet room code in an address, or null for anything that is not a Meet call. */
export function meetCodeFromAddress(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Exact host equality, never a substring: meet.google.com.evil.com and
  // evil.com/meet.google.com/abc-defg-hij both contain the string and neither is Google.
  if (url.hostname !== "meet.google.com") return null;
  const match = MEET_CODE_PATH.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * What one look found, from the browsers' answers.
 *
 * Throws when nothing could be read and at least one running browser refused: that is "could not
 * look", and it must stay distinguishable from "looked and saw no Meet", or a revoked permission
 * would read as the call having ended.
 */
export function sightingFromReports(reports: readonly MacBrowserReport[]): MeetSighting | null {
  for (const report of reports) {
    for (const address of report.urls ?? []) {
      const meetCode = meetCodeFromAddress(address);
      if (meetCode) return { meetCode, processId: null, via: "document" };
    }
  }
  const answered = reports.some((report) => report.urls !== undefined);
  const refused = reports.find((report) => report.error !== undefined);
  if (!answered && refused) {
    throw new Error(`${refused.name} did not answer: ${refused.error}`);
  }
  return null;
}

/** Long enough for the first-run permission prompt's wake-up, short enough to notice a hang. */
const READ_TIMEOUT_MS = 8000;

export class MacMeetUrlSensor {
  read(): Promise<MeetSighting | null> {
    return new Promise((resolve, reject) => {
      execFile(
        "osascript",
        ["-l", "JavaScript", "-e", MAC_SENSOR_SCRIPT],
        { timeout: READ_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            resolve(sightingFromReports(JSON.parse(stdout.trim()) as MacBrowserReport[]));
          } catch (cause) {
            reject(cause);
          }
        },
      );
    });
  }

  /** Nothing outlives a read. Present so both sensors can be stopped the same way. */
  stop(): void {}
}

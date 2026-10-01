/**
 * A gentle "sign in to translate this call" for a WarpTalk user who is in a Google Meet while the
 * app is signed out.
 *
 * WHY MAIN HAS TO DO THIS ITSELF
 *   The Meet sensor is armed by the web app's bridge trigger, which lives in the signed-in app
 *   shell. Signed out, the web app sits on /login, the trigger never mounts, the sensor is never
 *   armed - and nothing ever tells the user that the app they have open could translate the call
 *   they are in. So main arms the sensor on its own, but only while the web app is evidently not
 *   going to: it has not armed the sensor within a grace period after the page loaded, or it said
 *   outright that nobody is signed in.
 *
 * WHAT COUNTS AS SIGNED IN
 *   `reportSignedIn` when the web app sends it. A web app that predates that IPC never sends it, so
 *   "never reported" is unknown, not signed out - and the web app arming the sensor is taken as
 *   signed in, because only the signed-in shell does that. Unknown alone prompts only once the
 *   grace period has passed without an arm.
 *
 * WHAT IT NEVER DOES
 *   Force anything. One notification per Meet code for the life of the process, nothing for a
 *   sighting without a code (a picture-in-picture window), and it goes quiet the moment the web
 *   app arms the sensor or reports a session.
 *
 * Pure apart from the injected effects, so the tests need neither Electron nor a clock.
 */

import type { MeetPresence } from "../shared/types.ts";

export interface SignedOutMeetPromptOptions {
  /** Arm the shared presence watcher on main's behalf. Idempotent on the watcher's side. */
  armWatcher: () => void;
  /** Disarm it again. Called only for an arm this machine made and the web app has not adopted. */
  disarmWatcher: () => void;
  /** Show the prompt for this call. Called at most once per Meet code. */
  notify: (meetCode: string) => void;
  graceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Long enough for a signed-in shell to mount and arm the sensor; short enough to catch the call. */
export const SIGNED_OUT_GRACE_MS = 10_000;

export class SignedOutMeetPrompt {
  /** The web app's last word on the session; undefined until it says anything. */
  private signedIn: boolean | undefined = undefined;
  /** The web app has the sensor armed, for its own trigger. */
  private webArmed = false;
  /** The page has been loaded for longer than the grace period without the web app arming. */
  private graceElapsed = false;
  /** This machine armed the watcher and still holds that arm. */
  private mainArmed = false;
  private timer: unknown = null;
  private readonly prompted = new Set<string>();
  private readonly options: SignedOutMeetPromptOptions;

  constructor(options: SignedOutMeetPromptOptions) {
    this.options = options;
  }

  /** Whether main is the one watching for a Meet call right now. */
  get active(): boolean {
    return this.mainArmed;
  }

  /**
   * The main window started a full page load. Whatever the old page said about its session and its
   * sensor belongs to a page that is gone; the new one has to say it again.
   */
  pageLoadStarted(): void {
    this.cancelTimer();
    this.signedIn = undefined;
    this.webArmed = false;
    this.graceElapsed = false;
    this.reconcile();
  }

  /** The main window finished loading. The grace period runs from here. */
  pageLoaded(): void {
    this.cancelTimer();
    this.graceElapsed = false;
    const set = this.options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = set(() => {
      this.timer = null;
      this.graceElapsed = true;
      this.reconcile();
    }, this.options.graceMs ?? SIGNED_OUT_GRACE_MS);
  }

  /** The web app armed the sensor itself. Only the signed-in shell does. */
  webArmedWatcher(): void {
    this.webArmed = true;
    if (this.signedIn === undefined) this.signedIn = true;
    // The web app owns the arm now. Disarming here would pull the sensor out from under it.
    this.mainArmed = false;
    this.reconcile();
  }

  /** The web app disarmed the sensor - which turns off any arm main held too, it is one watcher. */
  webDisarmedWatcher(): void {
    this.webArmed = false;
    this.mainArmed = false;
    this.reconcile();
  }

  reportSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
    this.reconcile();
  }

  /** A change the presence watcher reported, whoever armed it. */
  presence(presence: MeetPresence): void {
    if (!this.mainArmed) return;
    if (!presence.meetWindowVisible || !presence.meetCode) return;
    if (this.prompted.has(presence.meetCode)) return;
    this.prompted.add(presence.meetCode);
    this.options.notify(presence.meetCode);
  }

  /** Quit: no timer left behind. The watcher itself is disarmed by the quit path. */
  dispose(): void {
    this.cancelTimer();
    this.mainArmed = false;
  }

  private shouldWatch(): boolean {
    if (this.webArmed) return false;
    if (this.signedIn === true) return false;
    return this.signedIn === false || this.graceElapsed;
  }

  private reconcile(): void {
    const want = this.shouldWatch();
    if (want && !this.mainArmed) {
      this.mainArmed = true;
      this.options.armWatcher();
    } else if (!want && this.mainArmed) {
      this.mainArmed = false;
      if (!this.webArmed) this.options.disarmWatcher();
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(
      this.timer,
    );
    this.timer = null;
  }
}

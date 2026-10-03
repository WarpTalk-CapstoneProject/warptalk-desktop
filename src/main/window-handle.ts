/**
 * One rule for "is this a window handle", shared by everything that carries an HWND between the
 * PowerShell helper, the call-state tracker, presence and the window capture (WT-910).
 *
 * An HWND arrives here as a decimal number: from the helper's JSON (`$w.H.ToInt64()`) or parsed out
 * of an Electron source id (`window:<HWND>:0`). Anything that is not a positive safe integer is not
 * one — 0 is "no window", and a fraction or a string means the payload is not what it claims.
 */
export function isWindowHandle(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

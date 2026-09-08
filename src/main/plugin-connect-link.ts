/**
 * The `warptalk://` link a finished plugin consent comes back through.
 *
 * Connecting a plugin opens the provider's consent screen in the system browser - the app window
 * never sees it - so when consent finishes the browser is holding the result and this app is not.
 * The web callback page turns that result into a link on this scheme, and this module decides
 * what, if anything, the app should open because of it.
 *
 * Separated from the main process because the string arrives from outside the app through an
 * OS-registered scheme that any page on the machine can invoke, and because the answer is worth
 * being able to test without an Electron window.
 */

export const PLUGIN_CONNECT_SCHEME = "warptalk";

const PLUGINS_ROUTE = "/settings/plugins";

/**
 * Only these travel onward.
 *
 * The link is rebuilt from a fixed set rather than forwarded whole: whatever comes out of here is
 * loaded on the trusted origin, and copying an arbitrary query into that is how a crafted link
 * turns into a page nobody meant to open.
 */
const CARRIED_PARAMS = ["status", "reason", "plugin", "ref"] as const;

/**
 * The app URL to open for a link, or null when the link is not a plugin-connect callback.
 *
 * @param webOrigin The origin the app window is already on. Null before the window has resolved
 * it, which is a real state on a cold start - the link arrives before there is anywhere to put it.
 */
export function pluginConnectTarget(link: string, webOrigin: string | null): string | null {
  if (!webOrigin) return null;

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }

  if (url.protocol !== `${PLUGIN_CONNECT_SCHEME}:`) return null;

  // The first segment lands in `hostname`, not in the path: a scheme URL is always parsed as
  // scheme://host/path, so `connect` is the host here. Reading the path alone would match nothing.
  const segments = [url.hostname, ...url.pathname.split("/")].filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "connect" || segments[2] !== "callback") return null;

  const carried = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) carried.set(key, value);
  }

  const query = carried.toString();
  return `${webOrigin}${PLUGINS_ROUTE}${query ? `?${query}` : ""}`;
}

/** The first scheme link in a launch's arguments - how Windows and Linux deliver one. */
export function firstPluginConnectLink(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PLUGIN_CONNECT_SCHEME}://`)) ?? null;
}

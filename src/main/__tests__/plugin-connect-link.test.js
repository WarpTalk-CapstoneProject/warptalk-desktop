import test from "node:test";
import assert from "node:assert/strict";

import { firstPluginConnectLink, pluginConnectTarget } from "../plugin-connect-link.ts";

const ORIGIN = "https://app.warptalk.io.vn";

test("carries the outcome of a finished consent onto the plugins page", () => {
  const target = pluginConnectTarget(
    "warptalk://connect/google/callback?status=connected&plugin=google_workspace",
    ORIGIN,
  );

  assert.equal(
    target,
    `${ORIGIN}/settings/plugins?status=connected&plugin=google_workspace`,
  );
});

test("keeps the reference a failure is diagnosed by", () => {
  const target = pluginConnectTarget(
    "warptalk://connect/google/callback?status=error&reason=provider_configuration&ref=b0ce0e47",
    ORIGIN,
  );

  assert.equal(
    target,
    `${ORIGIN}/settings/plugins?status=error&reason=provider_configuration&ref=b0ce0e47`,
  );
});

test("drops parameters it was not asked to carry", () => {
  // The link comes in over an OS-registered scheme any page can invoke, and whatever comes out of
  // here is loaded on the trusted origin. Forwarding the query whole is how a crafted link becomes
  // a page nobody meant to open.
  const target = pluginConnectTarget(
    "warptalk://connect/google/callback?status=connected&next=https://evil.example/&token=abc",
    ORIGIN,
  );

  assert.equal(target, `${ORIGIN}/settings/plugins?status=connected`);
});

test("ignores links that are not a plugin-connect callback", () => {
  for (const link of [
    "warptalk://connect/google",
    "warptalk://connect/google/callback/extra",
    "warptalk://rooms/42/join",
    "https://app.warptalk.io.vn/connect/google/callback?status=connected",
    "not a url",
  ]) {
    assert.equal(pluginConnectTarget(link, ORIGIN), null, link);
  }
});

test("holds off until the window has an origin to open the link against", () => {
  // A cold start receives the link a second or two before the web origin is resolved. Saying null
  // here is what lets the caller keep the link rather than resolve it against nothing.
  assert.equal(
    pluginConnectTarget("warptalk://connect/google/callback?status=connected", null),
    null,
  );
});

test("finds the scheme link Windows and Linux pass as a launch argument", () => {
  assert.equal(
    firstPluginConnectLink([
      "C:\\Program Files\\WarpTalk\\WarpTalk.exe",
      "--allow-file-access",
      "warptalk://connect/google/callback?status=connected",
    ]),
    "warptalk://connect/google/callback?status=connected",
  );
  assert.equal(firstPluginConnectLink(["WarpTalk.exe"]), null);
});

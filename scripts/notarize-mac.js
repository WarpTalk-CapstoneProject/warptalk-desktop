"use strict";

/**
 * electron-builder `afterSign` hook — submits the signed macOS bundle to Apple's notary service
 * and staples the ticket to it.
 *
 * WHY THIS EXISTS AS A HOOK RATHER THAN `mac.notarize`
 *
 * electron-builder can notarize on its own, but only through a config key, and the config is YAML
 * — it cannot read a team id out of the environment. Wiring `notarize: true` and supplying an
 * Apple ID takes electron-builder down its *legacy altool* branch, which passes no team id at all;
 * Apple decommissioned altool in 2023, so that path fails after the upload rather than before it.
 * `notarize: { teamId }` avoids that but hardcodes the team id in a file, and there is no honest
 * value to hardcode until a certificate actually exists. Doing it here keeps the whole decision in
 * one place: three environment variables present means notarize, absent means do not.
 *
 * WHERE THIS RUNS IN THE ORDER, WHICH IS THE ENTIRE POINT
 *
 *   pack → afterPack (ad-hoc sign, only when no certificate) → sign → **afterSign (here)** →
 *   build .dmg / .zip → write blockmaps and latest-mac.yml → publish
 *
 * The ticket has to be stapled to the .app *before* the disk image is built. Stapling afterwards
 * would rewrite bytes that the blockmap and the sha512 in latest-mac.yml were already computed
 * over, which silently breaks electron-updater for every existing install. That also answers the
 * obvious follow-up question — no, the .dmg itself is not notarized, and it does not need to be.
 * Gatekeeper evaluates the app, and the app carries its own stapled ticket even offline.
 *
 * ONE THING THAT IS NOT TRUE, ALTHOUGH THE DOCS IMPLY IT
 *
 * electron-builder is documented as skipping `afterSign` when no signing occurred. On macOS it
 * does not: `MacPackager.signApp` returns `true` unconditionally, so this hook runs on every mac
 * build including the ad-hoc ones. That is why the Developer ID check below is load-bearing rather
 * than decorative — with notary credentials configured and a certificate that failed to load, this
 * hook is what stands between an ad-hoc bundle and a fifteen-minute upload Apple was always going
 * to reject.
 */

const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { rmSync } = require("node:fs");

const CREDENTIALS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

/** Node puts the full argv in the message of a failed execFileSync, password included. */
function scrub(text) {
  const secret = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const string = String(text ?? "");
  return secret ? string.split(secret).join("***") : string;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", ...options });
  } catch (error) {
    throw new Error(scrub(error.stderr || error.stdout || error.message));
  }
}

/**
 * `codesign -dv` and `spctl -vv` both report on stderr and both exit non-zero on the very verdicts
 * we want to read, so neither can go through run(). Return everything they said and let the caller
 * decide what it means.
 */
function probe(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

module.exports = async function notarizeMac(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const present = CREDENTIALS.filter((name) => process.env[name]);

  if (present.length === 0) {
    console.log(
      "  • skipped notarization  reason=no notary credentials configured\n" +
        "    The build is signed but unnotarized: the first launch of a fresh download needs\n" +
        "    Open Anyway in System Settings > Privacy & Security. Set APPLE_ID,\n" +
        "    APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to remove that step."
    );
    return;
  }

  // Partial credentials are almost always a typo in a secret name, and the failure it would
  // otherwise produce is a release that looks complete and stops one row short of opening.
  if (present.length !== CREDENTIALS.length) {
    const missing = CREDENTIALS.filter((name) => !process.env[name]);
    throw new Error(
      `Notarization is half-configured: ${present.join(", ")} set but ${missing.join(", ")} missing. ` +
        "Set all three or none — a partial set silently ships an unnotarized build."
    );
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // The notary service rejects anything that is not signed with a Developer ID certificate, and it
  // does so ten minutes into an upload. Reading the authority here costs nothing and names the
  // actual problem: an ad-hoc signature is not a weaker Developer ID, it is a different thing.
  const description = probe("codesign", ["-dv", "--verbose=2", appPath]);
  if (!/Authority=Developer ID Application:/.test(description)) {
    throw new Error(
      "Refusing to notarize: the bundle is not signed with a Developer ID Application certificate.\n" +
        "Apple only notarizes Developer ID signatures — an Apple Development certificate, which is\n" +
        "what a free account issues, cannot be used for distribution outside the App Store.\n" +
        `codesign reported:\n${description.trim()}`
    );
  }

  const zipPath = path.join(
    os.tmpdir(),
    `${context.packager.appInfo.productFilename}-notarize-${context.arch}.zip`
  );

  try {
    console.log(`  • notarizing  app=${appPath}`);
    // notarytool takes an archive, and ditto is the only zip that preserves the symlinks inside a
    // framework. A plain `zip -r` produces a bundle Apple rejects as malformed.
    run("ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);

    const raw = run("xcrun", [
      "notarytool",
      "submit",
      zipPath,
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--wait",
      "--timeout",
      "30m",
      "--output-format",
      "json",
    ]);

    const result = JSON.parse(raw);
    if (result.status !== "Accepted") {
      let details = "";
      if (result.id) {
        try {
          details = run("xcrun", [
            "notarytool",
            "log",
            result.id,
            "--apple-id",
            process.env.APPLE_ID,
            "--password",
            process.env.APPLE_APP_SPECIFIC_PASSWORD,
            "--team-id",
            process.env.APPLE_TEAM_ID,
          ]);
        } catch (error) {
          details = `(could not fetch the notary log: ${error.message})`;
        }
      }
      throw new Error(
        `Notarization was not accepted: status=${result.status} id=${result.id}\n${details}`
      );
    }

    // Stapling is what makes the ticket travel with the download. Without it the app still passes,
    // but only on a machine that can reach Apple at launch time — which is not a promise worth
    // making about a demo laptop on conference wifi.
    run("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
    run("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });

    // The last word belongs to the thing that actually blocks the user. `spctl` is the same
    // evaluation Gatekeeper runs on a double click, so this is the check that the release is
    // openable rather than merely built.
    const assessment = probe("spctl", ["-a", "-t", "exec", "-vv", appPath]);
    if (!/source=Notarized Developer ID/.test(assessment)) {
      throw new Error(
        `Gatekeeper did not accept the stapled bundle:\n${assessment.trim()}`
      );
    }

    console.log(`  • notarized and stapled  app=${appPath}`);
  } finally {
    rmSync(zipPath, { force: true });
  }
};

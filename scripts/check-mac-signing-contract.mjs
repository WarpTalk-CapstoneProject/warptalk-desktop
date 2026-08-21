#!/usr/bin/env node
/**
 * Every electron-builder config must wire the macOS signing chain, and the entitlements it signs
 * with must still say what they need to say.
 *
 * WHAT HAPPENED
 *
 * v0.3.2 shipped a macOS build that no one could open. Not "warned about" — opened. The dialog
 * said "WarpTalk is damaged and can't be opened" and offered exactly two buttons, Move to Trash
 * and Cancel. Every stage before that was green: the workflow passed, all 16 assets uploaded, the
 * download page listed a 98 MB .dmg, and the file downloaded fine.
 *
 * The cause was a bundle electron-builder had modified but never re-sealed, because no
 * certificate is configured and it skips signing entirely rather than falling back to ad-hoc.
 * scripts/adhoc-sign-mac.js fixes that, and it verifies its own work — but only if it runs.
 *
 * Nothing else notices when it does not. An unwired hook produces no warning, no failed step, and
 * a .dmg of exactly the right size. The gap between "the fix exists in the repo" and "the fix ran
 * on the artifact we published" is the entire bug, so this script closes it before the build
 * rather than after the upload.
 *
 * THE SECOND HALF
 *
 * With a Developer ID certificate configured the failure mode moves rather than disappearing. The
 * hardened runtime stops being decorative and starts being enforced, and an entitlements file that
 * has lost `com.apple.security.device.audio-input` produces a build that installs, launches, looks
 * perfect and cannot open a microphone — in a translation client, a worse outcome than not opening
 * at all, because nothing about it looks broken. Those keys are checked here for the same reason
 * the hook is: nothing downstream would notice them missing.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const HOOKS = [
  {
    key: "afterPack",
    script: "scripts/adhoc-sign-mac.js",
    consequence:
      "The .dmg it produces will be reported as damaged and cannot be opened at all.",
  },
  {
    key: "afterSign",
    script: "scripts/notarize-mac.js",
    consequence:
      "A signed build would ship unnotarized, stopping at \"Apple could not verify\" on first launch.",
  },
];

const ENTITLEMENTS = [
  { file: "resources/entitlements.mac.plist", option: "entitlements" },
  { file: "resources/entitlements.mac.inherit.plist", option: "entitlementsInherit" },
];

// allow-jit is what keeps Electron running under the hardened runtime; the two device keys are
// what keep capture working. Losing any of them breaks a signed build only.
const REQUIRED_ENTITLEMENT_KEYS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
];

const failures = [];

for (const { script, consequence } of HOOKS) {
  if (!existsSync(join(root, script))) {
    failures.push(`${script} is missing. ${consequence}`);
  }
}

for (const { file, option } of ENTITLEMENTS) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(
      `${file} is missing, so electron-builder would fall back to its own three-key default and ` +
        `a signed build would lose the microphone and camera.`,
    );
    continue;
  }
  const plist = readFileSync(path, "utf8");
  for (const key of REQUIRED_ENTITLEMENT_KEYS) {
    if (!plist.includes(`<key>${key}</key>`)) {
      failures.push(`${file} no longer declares ${key}.`);
    }
  }
}

const configs = readdirSync(root).filter(
  (name) => name.startsWith("electron-builder") && /\.(ya?ml|json|js|cjs)$/.test(name),
);

if (configs.length === 0) {
  failures.push("Found no electron-builder config to check; expected at least one at the repo root.");
}

for (const config of configs) {
  const source = readFileSync(join(root, config), "utf8");
  // A `mac:` section is what makes any of this mandatory — a Windows-only config would not need it.
  if (!/^\s*mac:/m.test(source)) continue;

  for (const { key, script, consequence } of HOOKS) {
    if (!source.includes(`${key}: ${script}`)) {
      failures.push(
        `${config} builds a macOS target but does not wire "${key}: ${script}". ${consequence}`,
      );
    }
  }

  for (const { file, option } of ENTITLEMENTS) {
    if (!source.includes(`${option}: ${file}`)) {
      failures.push(`${config} does not point "${option}" at ${file}.`);
    }
  }

  // electron-builder's own notarization takes a legacy altool branch when handed an Apple ID and
  // no team id, and Apple decommissioned altool in 2023. scripts/notarize-mac.js owns this job.
  if (!/^\s*notarize:\s*false\s*$/m.test(source)) {
    failures.push(
      `${config} must set "notarize: false" — notarization belongs to scripts/notarize-mac.js, ` +
        `and electron-builder's built-in path fails after the upload rather than before it.`,
    );
  }
}

if (failures.length > 0) {
  console.error("FAIL macOS signing contract\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(`PASS macOS signing contract (${configs.length} config(s) checked)`);

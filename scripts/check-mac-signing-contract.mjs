#!/usr/bin/env node
/**
 * Every electron-builder config must wire the ad-hoc signing hook.
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
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = "scripts/adhoc-sign-mac.js";
const failures = [];

if (!existsSync(join(root, HOOK))) {
  failures.push(`${HOOK} is missing. Without it every macOS release ships unopenable.`);
}

const configs = readdirSync(root).filter(
  (name) => name.startsWith("electron-builder") && /\.(ya?ml|json|js|cjs)$/.test(name),
);

if (configs.length === 0) {
  failures.push("Found no electron-builder config to check; expected at least one at the repo root.");
}

for (const config of configs) {
  const source = readFileSync(join(root, config), "utf8");
  // A `mac:` section is what makes the hook mandatory — a Windows-only config would not need it.
  if (!/^\s*mac:/m.test(source)) continue;
  if (!source.includes(HOOK)) {
    failures.push(
      `${config} builds a macOS target but does not wire "afterPack: ${HOOK}". ` +
        `The .dmg it produces will be reported as damaged and cannot be opened at all.`,
    );
  }
}

if (failures.length > 0) {
  console.error("FAIL macOS signing contract\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(`PASS macOS signing contract (${configs.length} config(s) checked)`);

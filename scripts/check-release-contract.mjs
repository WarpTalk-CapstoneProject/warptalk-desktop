#!/usr/bin/env node
/**
 * The self-updater (WT-618) works only while four unrelated files keep agreeing with each other.
 *
 * WHY A SCRIPT
 *
 * Every link in the chain fails silently, and it fails in the release users already have. A build
 * that loses its `publish:` block ships with no resources/app-update.yml, so electron-updater has
 * no feed and every copy of that release is stranded on it for good: the update that would fix it
 * is exactly what it can no longer receive. A main bundle that inlines electron-updater instead of
 * requiring it, or a package.json that moves it to devDependencies so it is not packed into
 * app.asar, fails the same way - at runtime, after the release is out, with nothing in CI red.
 *
 * WHAT IS CHECKED
 *
 *   1. Every electron-builder config publishes to this repo's GitHub releases, as full releases.
 *      A draft is invisible to the "latest release" lookup electron-updater makes.
 *   2. Windows still builds the NSIS target: it is the only Windows target NsisUpdater can install.
 *   3. electron.vite.config.ts keeps electron-updater in the main process's external list.
 *   4. electron-updater is a runtime dependency, so electron-builder packs it next to the bundle.
 *   5. Nothing in src/main turns forceDevUpdateConfig on - a debugging switch that reads
 *      dev-app-update.yml instead of the real feed.
 *   6. With --built: out/main/index.js (from `electron-vite build`) really requires electron-updater
 *      rather than carrying an inlined copy. Checks 3 and 4 are about intent; this is the artifact.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkBuilt = process.argv.includes("--built");
const failures = [];

const OWNER = "WarpTalk-CapstoneProject";
const REPO = "warptalk-desktop";

// 1 + 2. electron-builder configs.
const configs = readdirSync(root).filter((name) => /^electron-builder.*\.ya?ml$/.test(name));
if (configs.length === 0) {
  failures.push("Found no electron-builder*.yml at the repo root; expected at least one.");
}

for (const config of configs) {
  const source = readFileSync(join(root, config), "utf8");
  // The block runs from a top-level `publish:` to the next top-level key.
  const block = /^publish:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(source)?.[1];
  if (!block) {
    failures.push(
      `${config} has no top-level "publish:" block. Its builds would ship without app-update.yml, ` +
        `and every install of them could never update itself again.`,
    );
    continue;
  }
  const expect = [
    [/^\s*provider:\s*github\s*$/m, "provider: github"],
    [new RegExp(`^\\s*owner:\\s*${OWNER}\\s*$`, "m"), `owner: ${OWNER}`],
    [new RegExp(`^\\s*repo:\\s*${REPO}\\s*$`, "m"), `repo: ${REPO}`],
    [/^\s*releaseType:\s*release\s*$/m, "releaseType: release"],
  ];
  for (const [pattern, line] of expect) {
    if (!pattern.test(block)) failures.push(`${config} "publish:" no longer says "${line}".`);
  }

  if (/^win:/m.test(source)) {
    const win = /^win:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(source)?.[1] ?? "";
    if (!/^\s*-\s*(target:\s*)?nsis\s*$/m.test(win)) {
      failures.push(`${config} no longer builds the Windows "nsis" target, the only one NsisUpdater installs.`);
    }
  }
}

// 3. The main bundle leaves electron-updater external.
const viteConfigPath = join(root, "electron.vite.config.ts");
if (!existsSync(viteConfigPath)) {
  failures.push("electron.vite.config.ts is missing; nothing keeps electron-updater out of the main bundle.");
} else {
  const viteConfig = readFileSync(viteConfigPath, "utf8");
  const mainSection = /\bmain:\s*\{([\s\S]*?)\n\s*preload:/.exec(viteConfig)?.[1] ?? "";
  const external = /external:\s*\[([^\]]*)\]/.exec(mainSection)?.[1] ?? "";
  if (!/["']electron-updater["']/.test(external)) {
    failures.push(
      `electron.vite.config.ts no longer lists "electron-updater" in main's rollupOptions.external. ` +
        `Rollup would inline it and its fs-extra / js-yaml / builder-util-runtime dependencies.`,
    );
  }
}

// 4. Packed at runtime.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!pkg.dependencies?.["electron-updater"]) {
  failures.push(
    `electron-updater is not in package.json "dependencies". An external module that is not a ` +
      `runtime dependency is not packed into app.asar, and require("electron-updater") throws at launch.`,
  );
}

// 5. No debugging switch left on.
const mainDir = join(root, "src", "main");
for (const file of readdirSync(mainDir).filter((name) => name.endsWith(".ts"))) {
  const source = readFileSync(join(mainDir, file), "utf8");
  if (/forceDevUpdateConfig\s*=\s*true/.test(source)) {
    failures.push(`src/main/${file} sets forceDevUpdateConfig = true; that reads dev-app-update.yml, not the release feed.`);
  }
}

// 6. The artifact itself.
if (checkBuilt) {
  const bundlePath = join(root, "out", "main", "index.js");
  if (!existsSync(bundlePath)) {
    failures.push("--built was given but out/main/index.js does not exist. Run `npx electron-vite build` first.");
  } else if (!readFileSync(bundlePath, "utf8").includes('require("electron-updater")')) {
    failures.push(
      `out/main/index.js does not contain require("electron-updater"). The updater was either ` +
        `inlined by rollup or dropped from the bundle.`,
    );
  }
}

if (failures.length > 0) {
  console.error("FAIL release / auto-update contract\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `PASS release / auto-update contract (${configs.length} builder config(s)` +
    `${checkBuilt ? ", built main bundle" : ""} checked)`,
);

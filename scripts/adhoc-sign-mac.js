"use strict";

/**
 * electron-builder `afterPack` hook — ad-hoc signs the macOS bundle.
 *
 * Without this, a downloaded WarpTalk build dies on the very first double click with
 *
 *     "WarpTalk" is damaged and can't be opened. You should move it to the Trash.
 *
 * and the dialog offers no way past it — only "Move to Trash" and "Cancel".
 *
 * The cause is NOT that the app is unsigned. It is that the app is *half* signed. Prebuilt
 * Electron binaries ship with a linker-signed ad-hoc signature covering the executable alone.
 * electron-builder then rewrites Info.plist, renames the bundle, and copies extraResources in —
 * which invalidates that signature — and because no certificate is configured the release
 * workflow sets CSC_IDENTITY_AUTO_DISCOVERY=false, so electron-builder skips signing entirely
 * and never re-seals the bundle. What ships is:
 *
 *     Identifier=Electron        Info.plist=not bound        Sealed Resources=none
 *     $ spctl -a -t exec WarpTalk.app
 *     WarpTalk.app: code has no resources but signature indicates they must be present
 *
 * Gatekeeper reads a signature that claims resources it cannot find as *tampered with*, and a
 * tampered app is reported as damaged. Re-sealing the bundle ad-hoc is what fixes it:
 *
 *     $ codesign --verify --deep --strict WarpTalk.app
 *     WarpTalk.app: valid on disk
 *     WarpTalk.app: satisfies its Designated Requirement
 *
 * This does not make the app notarized — Gatekeeper still refuses a quarantined download, but it
 * refuses it with "Apple could not verify ...", which the user CAN get past (Open Anyway in
 * System Settings › Privacy & Security). Damaged → openable is the whole win here; removing the
 * warning outright needs a paid Apple Developer ID and notarization, see README.
 *
 * electron-builder's `afterSign` hook cannot do this job: it is skipped precisely when no signing
 * occurred, which is exactly our case. `afterPack` runs after the bundle is fully assembled and
 * before the dmg/zip is built, so the signature seals the same bytes the user downloads.
 */

const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  // `codesign` only exists on macOS. The release matrix builds mac on a macOS runner, so this
  // guard only trips for someone cross-building a dir target, which produces nothing shippable.
  if (process.platform !== "darwin") {
    console.log("  • skipped ad-hoc signing  reason=not running on macOS");
    return;
  }

  // A configured certificate is the real thing: electron-builder signs with it right after this
  // hook, with the hardened runtime and entitlements an ad-hoc signature cannot carry.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log("  • skipped ad-hoc signing  reason=certificate configured, electron-builder will sign");
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`  • ad-hoc signing  app=${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Verify rather than trust. A bundle that fails here is the "damaged" bug all over again, and
  // failing the build is far cheaper than finding out from a download page.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("  • ad-hoc signature verified  note=unnotarized, first launch needs Open Anyway");
};

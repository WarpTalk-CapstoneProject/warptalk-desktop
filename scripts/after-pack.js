const path = require("path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const { rcedit } = await import("rcedit");
  const appVersion = context.packager.appInfo.version;
  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const projectDir = path.resolve(__dirname, "..");
  const iconPath = path.join(
    projectDir,
    "resources",
    "warptalk-logo-primary.ico",
  );

  await rcedit(exePath, {
    "file-version": appVersion,
    icon: iconPath,
    "product-version": appVersion,
    "version-string": {
      CompanyName: "WarpTalk Team",
      FileDescription: "Warptalk-V1",
      ProductName: "Warptalk-V1",
    },
  });
};

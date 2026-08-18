const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const desktopRoot = path.resolve(__dirname, "..");
const webRoot = path.resolve(desktopRoot, "..", "warptalk-web");
const productionMode = process.argv.includes("--production");
const envFile = productionMode
  ? path.join(desktopRoot, ".env.production.local")
  : path.join(webRoot, ".env.local");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }
  return values;
}

const loadedEnv = parseEnvFile(envFile);
const buildEnv = {
  ...process.env,
  ...loadedEnv,
  NEXT_TELEMETRY_DISABLED: "1",
};

if (productionMode) {
  const requiredKeys = [
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_SIGNALR_URL",
    "NEXT_PUBLIC_LIVEKIT_URL",
    "API_GATEWAY_URL",
  ];
  const missingKeys = requiredKeys.filter((key) => !buildEnv[key]);
  if (missingKeys.length > 0) {
    console.error(
      `Missing ${missingKeys.join(", ")} in ${path.relative(desktopRoot, envFile)}.`,
    );
    process.exit(1);
  }

  const localValues = requiredKeys.filter((key) =>
    /localhost|127\.0\.0\.1/i.test(buildEnv[key] ?? ""),
  );
  if (localValues.length > 0) {
    console.error(
      `Production desktop build cannot use local URLs: ${localValues.join(", ")}.`,
    );
    process.exit(1);
  }
}

console.log(
  `Building warptalk-web for desktop with ${
    fs.existsSync(envFile) ? path.relative(desktopRoot, envFile) : "process env"
  }.`,
);

const result = spawnSync("npm", ["run", "build"], {
  cwd: webRoot,
  env: buildEnv,
  shell: true,
  stdio: "inherit",
});

process.exit(result.status ?? 1);

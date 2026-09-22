const { existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Only public E2E settings are bundled, so manual and recovery launches
// work without launch arguments. Provider credentials stay in Node.
const envFilePath =
  process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ??
  path.join(__dirname, ".env.hotupdater");
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}
writeFileSync(
  path.join(__dirname, "src/e2eBuildConfig.js"),
  `module.exports = ${JSON.stringify({
    HOT_UPDATER_APP_BASE_URL: process.env.HOT_UPDATER_APP_BASE_URL,
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
      process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
  })};\n`,
);

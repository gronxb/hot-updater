const { existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");

/**
 * Writes the public E2E settings the app bundles, so manual and recovery
 * launches work without launch arguments. Provider credentials stay in Node.
 * A target app's bundler config calls it with the app's directory, whose
 * `.env.hotupdater` holds the settings unless HOT_UPDATER_E2E_ENV_TARGET_PATH
 * names another file.
 */
function writeE2eBuildConfig(appDir) {
  const envFilePath =
    process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ??
    path.join(appDir, ".env.hotupdater");
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
  writeFileSync(
    path.join(__dirname, "src/e2eBuildConfig.js"),
    `module.exports = ${JSON.stringify({
      HOT_UPDATER_APP_BASE_URL: process.env.HOT_UPDATER_APP_BASE_URL,
      HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
        process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
      HOT_UPDATER_API_KEY: process.env.HOT_UPDATER_API_KEY,
    })};\n`,
  );
}

module.exports = { writeE2eBuildConfig };

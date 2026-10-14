const { existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Bundles the app's public Hot Updater settings, the server URL and the client
// API key, from the build environment or .env.hotupdater. Provider credentials
// stay in Node.
const envFilePath = path.join(__dirname, ".env.hotupdater");
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}
writeFileSync(
  path.join(__dirname, "src/hotUpdaterBuildConfig.js"),
  `module.exports = ${JSON.stringify({
    HOT_UPDATER_APP_BASE_URL: process.env.HOT_UPDATER_APP_BASE_URL,
    HOT_UPDATER_API_KEY: process.env.HOT_UPDATER_API_KEY,
  })};\n`,
);

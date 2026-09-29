import { existsSync } from "node:fs";

const envTargetPath = process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH;
if (envTargetPath && existsSync(envTargetPath)) {
  process.loadEnvFile(envTargetPath);
}

const { hotUpdater, migrateDatabase } = await import("../src/db");
await migrateDatabase();

const apiKey = process.env.HOT_UPDATER_API_KEY?.trim();
if (!apiKey) {
  throw new Error("HOT_UPDATER_API_KEY is required");
}

// The apiKeys() plugin's API, on the tables the server checks.
await hotUpdater.api.apiKeys.register({ apiKey, name: "hot-updater-e2e" });

console.log("api-key-ready");

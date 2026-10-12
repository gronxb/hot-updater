import { existsSync } from "node:fs";

import { BlobServiceClient } from "@azure/storage-blob";
import {
  azureBlobStorage,
  cosmosDatabase,
  migrateCosmosDatabase,
} from "@hot-updater/azure";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

// HOT_UPDATER_API_KEY comes from the E2E environment file; the emulator
// connection strings from e2e-env.sh.
const envTargetPath = process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH;
if (envTargetPath && existsSync(envTargetPath)) {
  process.loadEnvFile(envTargetPath);
}

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const storageConnectionString = required(
  "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
);
const cosmosConnectionString = required(
  "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
);
const containerName = required("HOT_UPDATER_AZURE_BLOB_CONTAINER");
// The managed Azure server's plugins: Insights, API keys on client routes, and Remote Config.
const plugins = [insights(), apiKeys(), remoteConfig()];

await BlobServiceClient.fromConnectionString(storageConnectionString)
  .getContainerClient(containerName)
  .createIfNotExists();
await migrateCosmosDatabase(
  { connectionString: cosmosConnectionString },
  plugins,
);

const database = cosmosDatabase({ connectionString: cosmosConnectionString });
try {
  // The apiKeys() plugin's API, on the tables the server checks.
  await createHotUpdater({
    database,
    plugins,
    storage: azureBlobStorage({
      connectionString: storageConnectionString,
      containerName,
    }),
  }).api.apiKeys.register({
    apiKey: required("HOT_UPDATER_API_KEY"),
    name: "hot-updater-e2e",
  });
} finally {
  await database.dispose?.();
}

console.log("api-key-ready");

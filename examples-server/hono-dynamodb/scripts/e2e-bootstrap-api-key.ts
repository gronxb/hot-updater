import { registerApiKey } from "@hot-updater/server";

import { database } from "../src/db";

const apiKey = process.env.HOT_UPDATER_API_KEY?.trim();
if (!apiKey) {
  throw new Error("HOT_UPDATER_API_KEY is required");
}

await registerApiKey({
  apiKey,
  apiKeys: database.models.apiKeys,
  name: "hot-updater-e2e",
});

console.log("api-key-ready");

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { provisionApiKey } from "@hot-updater/server";

import * as target from "./api-key.config.ts";

const { database } = target;

const keyPath = new URL("./api-key.local", import.meta.url);
try {
  let apiKey = await readFile(keyPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const existingApiKey = process.env.HOT_UPDATER_API_KEY?.trim();
  if (apiKey && existingApiKey && apiKey.trim() !== existingApiKey) {
    throw new Error(
      "Saved client keys differ. Resolve the target key before provisioning.",
    );
  }
  if (!apiKey) {
    apiKey = existingApiKey || randomBytes(32).toString("base64url");
    await writeFile(keyPath, apiKey, { flag: "wx", mode: 0o600 });
  }
  // Providers without migration tooling (Firestore) write their schema settings here.
  await target.migrate?.();
  const result = await provisionApiKey({
    apiKeys: database.models.apiKeys,
    existingApiKey: apiKey.trim(),
    name: "Agent infrastructure setup",
  });
  console.log(
    `Client key registered: ${result.record.id}. Key saved in api-key.local.`,
  );
} finally {
  await database.dispose?.();
}

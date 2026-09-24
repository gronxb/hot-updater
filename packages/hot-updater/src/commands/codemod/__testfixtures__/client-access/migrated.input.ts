import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";

import { database } from "./database";

export const publicServer = createHotUpdater({
  database,
  plugins: [insights()],
  clientAccess: "public",
});

export const privateServer = createHotUpdater({
  database,
  plugins: [insights(), apiKeys({ headerName: "x-hot-updater-key" })],
});

// Insights stays off for this one.
export const quietServer = createHotUpdater({ database, clientAccess: "public" });

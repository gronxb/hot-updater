import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";

import { auditLog } from "./auditLog";
import { database, storage } from "./providers";

const API_KEY_HEADER = "x-hot-updater-key";

export const hotUpdater = createHotUpdater({
  database,
  plugins: [
    insights(),
    auditLog(),
    apiKeys({ headerName: API_KEY_HEADER }),
  ],
  storage,
});

export const publicHotUpdater = createHotUpdater({
  database,
  plugins: [],
  clientAccess: "public",
});

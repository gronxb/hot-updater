import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";

import { auditLog } from "./auditLog";
import { database, storage } from "./providers";

const API_KEY_HEADER = "x-hot-updater-key";

export const hotUpdater = createHotUpdater({
  database,
  plugins: [
    insights(),
    auditLog(),
  ],
  clientAccess: { type: "api-key", headerName: API_KEY_HEADER }, // mobile builds send it
  storage,
});

export const publicHotUpdater = createHotUpdater({
  database,
  plugins: [],
  clientAccess: { type: "public" },
});

import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";

import { database } from "./database";

const headerName = process.env.API_KEY_HEADER ?? "x-api-key";

export const hotUpdater = createHotUpdater({
  database,
  plugins: [apiKeys({ headerName })],
});

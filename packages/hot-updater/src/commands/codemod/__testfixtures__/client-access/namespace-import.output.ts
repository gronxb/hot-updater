import * as server from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights as insightsPlugin } from "@hot-updater/server/plugins/insights";

import { database } from "./database";

export const hotUpdater = server.createHotUpdater({
  database,
  plugins: [insightsPlugin(), apiKeys()],
});

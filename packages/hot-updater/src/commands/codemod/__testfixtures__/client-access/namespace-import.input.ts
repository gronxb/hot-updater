import * as server from "@hot-updater/server";
import { insights as insightsPlugin } from "@hot-updater/server/plugins/insights";

import { database } from "./database";

export const hotUpdater = server.createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
});

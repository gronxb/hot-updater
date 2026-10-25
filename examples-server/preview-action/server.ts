import { createHotUpdater } from "@hot-updater/server";

import { database, storage } from "./shared.ts";

/** Only for `hot-updater db migrate server.ts`, which creates core's tables. */
export const hotUpdater = createHotUpdater({
  database,
  storage,
  plugins: [],
  clientAccess: "public",
});

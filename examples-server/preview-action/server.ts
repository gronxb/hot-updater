import { createHotUpdater } from "@hot-updater/server";
import { vault } from "@hot-updater/server/plugins";

import { database, storage } from "./shared.ts";

/**
 * Only for `hot-updater db migrate server.ts`, which creates core's tables
 * and the vault's: a server never runs vault().
 */
export const hotUpdater = createHotUpdater({
  database,
  storage,
  plugins: [vault()],
  clientAccess: "public",
});

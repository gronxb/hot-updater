import { createHotUpdater } from "@hot-updater/server";
import { vault } from "@hot-updater/server/plugins";

import { database, storage } from "./database";

// What `hot-updater db migrate vault-console/server.ts` reads: core's tables
// and the vault's, on the console's database.
export const hotUpdater = createHotUpdater({
  database,
  storage,
  plugins: [vault()],
  clientAccess: "public",
});

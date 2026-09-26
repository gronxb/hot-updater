// Hot Updater server (서버 설정 — café ☕)
import { createHotUpdater } from "@hot-updater/server"; // the server package
import { insights } from "@hot-updater/server/plugins/insights";

import { database, storage } from "./providers";

/**
 * The beta app checks for updates without a key.
 */
export const hotUpdater = createHotUpdater({
  // The database `hot-updater db migrate` reads.
  database,
  /* Public update checks for the beta app. */
  clientAccess: "public", // 공개
  plugins: [insights()],
  storage, // kept as is
});

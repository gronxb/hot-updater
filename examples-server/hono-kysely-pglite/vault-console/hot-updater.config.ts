import { defineConfig } from "hot-updater";
import { vault } from "hot-updater/plugins";

import { database, storage } from "./database";

// The console the E2E vault scenario starts with `vault()` and a master key,
// over its own database: the E2E server's PGlite is open in the server's
// process. It serves the vault's routes and signs bundles; the scenario's
// deploy reaches it with HOT_UPDATER_CONSOLE_URL and a vault token alone.
export default defineConfig({
  updateStrategy: "appVersion",
  build: () => {
    throw new Error("The vault console builds no bundles.");
  },
  storage,
  database,
  plugins: [vault()],
});

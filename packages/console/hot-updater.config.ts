import { database, plugins, storage } from "./demoDatabase";

// The demo console (`pnpm dev`) and `hot-updater console` read the database,
// storage, and plugins here, as the CLI does.
export default {
  updateStrategy: "fingerprint" as const,
  build: async () => null,
  database,
  storage,
  plugins,
  console: {
    gitUrl: "https://github.com/gronxb/hot-updater",
  },
};

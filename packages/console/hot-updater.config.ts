// The demo console (`pnpm dev`) and `hot-updater console` read the server
// hotUpdater.ts defines.
export default {
  updateStrategy: "fingerprint" as const,
  build: async () => null,
  server: "./hotUpdater.ts",
  console: {
    gitUrl: "https://github.com/gronxb/hot-updater",
  },
};

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globalSetup: "./vitest.global-setup.mts",
    poolOptions: {
      workers: {
        wrangler: { configPath: "./worker/wrangler.test.json" },
      },
    },
  },
});

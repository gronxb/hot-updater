import path from "path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globalSetup: path.resolve(__dirname, "vitest.global-setup.mts"),
    poolOptions: {
      workers: {
        wrangler: {
          configPath: path.resolve(__dirname, "worker", "wrangler.test.json"),
        },
      },
    },
  },
});

import path from "path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.resolve(__dirname, "worker", "wrangler.test.json"),
      },
    }),
  ],
  test: {
    globalSetup: path.resolve(__dirname, "vitest.global-setup.mts"),
  },
});

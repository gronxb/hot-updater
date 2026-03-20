import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig({
  root,
  test: {
    include: ["**/*.spec.ts", "**/*.test.ts"],
    exclude: ["dist/**", "worker/dist/**", "node_modules/**", ".ignored/**"],
    globalSetup: resolve(root, "vitest.global-setup.mts"),
    poolOptions: {
      workers: {
        wrangler: {
          configPath: resolve(root, "worker", "wrangler.test.json"),
        },
      },
    },
  },
});

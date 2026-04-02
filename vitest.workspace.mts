import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";

const rootExclude = ["**/dist/**", "**/lib/**", "**/node_modules/**"];
const unitInclude = [
  "packages/**/*.spec.ts",
  "packages/**/*.test.ts",
  "plugins/**/*.spec.ts",
  "plugins/**/*.test.ts",
  "examples-server/**/*.spec.ts",
  "examples-server/**/*.test.ts",
];
const integrationInclude = [
  "packages/**/*.integration.spec.ts",
  "plugins/**/*.integration.spec.ts",
  "examples-server/**/*.integration.spec.ts",
];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      defineProject({
        test: {
          name: "unit:default",
          include: unitInclude,
          exclude: [
            ...rootExclude,
            "**/*.integration.spec.ts",
            "packages/console/**",
            "packages/bsdiff/tests/runtime/*.manual.*",
          ],
          environment: "node",
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      }),
      defineProject({
        test: {
          name: "unit:console",
          environment: "jsdom",
          include: [
            "packages/console/**/*.spec.ts",
            "packages/console/**/*.test.ts",
          ],
          exclude: [...rootExclude, "**/*.integration.spec.ts"],
        },
      }),
      defineProject({
        test: {
          name: "integration:default",
          environment: "node",
          include: integrationInclude,
          exclude: [
            ...rootExclude,
            "plugins/cloudflare/**/*.integration.spec.ts",
            "packages/bsdiff/tests/runtime/*.manual.*",
          ],
          fileParallelism: false,
          globalSetup: ["./plugins/firebase/vitest.global-setup.ts"],
          maxConcurrency: 1,
          maxWorkers: 1,
          pool: "forks",
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./plugins/cloudflare/worker/wrangler.test.json",
            },
          }),
        ],
        test: {
          name: "integration:cloudflare",
          include: ["plugins/cloudflare/worker/**/*.integration.spec.ts"],
          globalSetup: "./plugins/cloudflare/vitest.global-setup.mts",
        },
      }),
    ],
  },
});

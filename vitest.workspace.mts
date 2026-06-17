import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";

const rootExclude = [
  "**/dist/**",
  "**/lib/**",
  "**/node_modules/**",
  "**/runtime-acceptance-*/**",
];
const unitInclude = [
  "packages/**/*.spec.ts",
  "packages/**/*.test.ts",
  "plugins/**/*.spec.ts",
  "plugins/**/*.test.ts",
  "examples-server/**/*.spec.ts",
  "examples-server/**/*.test.ts",
];
const e2eUnitInclude = ["e2e/**/*.spec.ts", "e2e/**/*.test.ts"];
const integrationInclude = [
  "packages/**/*.integration.spec.ts",
  "plugins/**/*.integration.spec.ts",
  "examples-server/**/*.integration.spec.ts",
];
const sourceAliases = {
  "@hot-updater/core/dbSchemaArtifacts": fileURLToPath(
    new URL("./packages/core/src/dbSchemaArtifacts.ts", import.meta.url),
  ),
};

export default defineConfig({
  resolve: {
    alias: sourceAliases,
    tsconfigPaths: true,
  },
  test: {
    projects: [
      defineProject({
        resolve: {
          alias: sourceAliases,
        },
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
        resolve: {
          alias: sourceAliases,
        },
        test: {
          name: "unit:e2e",
          include: e2eUnitInclude,
          exclude: [...rootExclude, "e2e/results/**"],
          environment: "node",
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      }),
      defineProject({
        resolve: {
          alias: sourceAliases,
        },
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
        resolve: {
          alias: sourceAliases,
        },
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
        resolve: {
          alias: sourceAliases,
        },
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

import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";

const consoleSource = fileURLToPath(
  new URL("./packages/console/src", import.meta.url),
);
const commonExclude = [
  "**/dist/**",
  "**/node_modules/**",
  "**/runtime-acceptance-*/**",
];
const rootExclude = [...commonExclude, "**/lib/**"];
const unitInclude = [
  "packages/**/*.spec.ts",
  "packages/**/*.test.ts",
  "plugins/**/*.spec.ts",
  "plugins/**/*.test.ts",
  "examples-server/**/*.spec.ts",
  "examples-server/**/*.test.ts",
];
const e2eUnitInclude = ["e2e/**/*.spec.ts", "e2e/**/*.test.ts"];
const storageV2CertificationInclude = [
  "tests/storage-v2-certification/**/*.spec.ts",
  "tests/storage-v2-certification/**/*.test.ts",
];
const manualQaArchive =
  "packages/test-utils/src/storage/release/manualQaArchive.spec.ts";
const pluginCorePackedArtifact =
  "plugins/plugin-core/src/packedArtifact.spec.ts";
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
            manualQaArchive,
            pluginCorePackedArtifact,
          ],
          environment: "node",
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      }),
      defineProject({
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
        test: {
          name: "unit:storage-v2-certification",
          include: storageV2CertificationInclude,
          exclude: rootExclude,
          environment: "node",
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      }),
      defineProject({
        resolve: {
          alias: {
            "@": consoleSource,
          },
        },
        test: {
          name: "unit:console",
          environment: "jsdom",
          include: [
            "packages/console/**/*.spec.ts",
            "packages/console/**/*.spec.tsx",
            "packages/console/**/*.test.ts",
            "packages/console/**/*.test.tsx",
          ],
          exclude: [...commonExclude, "**/*.integration.spec.ts"],
        },
      }),
      defineProject({
        test: {
          name: "package-qa:plugin-core-artifact",
          include: [pluginCorePackedArtifact],
          exclude: rootExclude,
          environment: "node",
          fileParallelism: false,
          hookTimeout: 60000,
          maxConcurrency: 1,
          maxWorkers: 1,
          pool: "forks",
          testTimeout: 60000,
        },
      }),
      defineProject({
        test: {
          name: "manual-qa:storage-v2-archive",
          include: [manualQaArchive],
          exclude: rootExclude,
          environment: "node",
          fileParallelism: false,
          hookTimeout: 180000,
          maxConcurrency: 1,
          maxWorkers: 1,
          pool: "forks",
          testTimeout: 180000,
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
          sequence: {
            groupOrder: 0,
          },
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
          sequence: {
            groupOrder: 1,
          },
        },
      }),
    ],
  },
});

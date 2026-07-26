import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, it } from "vitest";

import {
  createPackedConsumer,
  type PackedConsumer,
  resolveServerPluginPackageDirectories,
  runNode,
} from "./packedPackageTestUtils";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const packageDirectories = resolveServerPluginPackageDirectories(workspaceRoot);

const consumerSource = `
import type { AnalyticsFeatureAvailable } from "@hot-updater/analytics";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { standaloneAnalytics } from "@hot-updater/standalone";

declare const database: DatabasePlugin;
const runtime = createHotUpdater({
  database,
  plugins: [
    standaloneAnalytics({
      baseUrl: "https://updates.example.com",
    }),
  ],
});
runtime.features.analytics satisfies AnalyticsFeatureAvailable<undefined>;
void runtime.features.analytics.getBundleEventSummary;
`;

let consumer: PackedConsumer;

beforeAll(async () => {
  consumer = await createPackedConsumer(packageDirectories);
}, 60_000);

afterAll(async () => {
  await consumer.dispose();
});

describe("packed standalone analytics declaration consumers", () => {
  it.each(["consumer.mts", "consumer.cts"])(
    "projects the analytics API for strict NodeNext %s",
    async (file) => {
      await writeFile(path.join(consumer.directory, file), consumerSource);
      const typescriptCli = path.join(
        workspaceRoot,
        "node_modules",
        "typescript",
        "bin",
        "tsc",
      );
      await access(typescriptCli);
      await runNode(
        consumer.directory,
        `const { spawnSync } = require("node:child_process");
const result = spawnSync(
  process.execPath,
  ${JSON.stringify([
    typescriptCli,
    "--exactOptionalPropertyTypes",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--noEmit",
    "--noUncheckedIndexedAccess",
    "--skipLibCheck",
    "false",
    "--strict",
    "--target",
    "ES2022",
    file,
  ])},
  { cwd: ${JSON.stringify(consumer.directory)}, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);`,
        false,
      );
    },
  );
});

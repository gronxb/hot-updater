import { access, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPackedConsumer,
  type PackedConsumer,
  resolveServerPluginPackageDirectories,
  runNode,
} from "./packedPackageTestUtils";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const packageDirectories = resolveServerPluginPackageDirectories(workspaceRoot);

let consumer: PackedConsumer;

const exportedFunctions = [
  ["@hot-updater/plugin-core", "defineCapability"],
  ["@hot-updater/server", "createHotUpdater"],
  [
    "@hot-updater/server/internal/first-party-plugin",
    "defineFirstPartyFeatureManifest",
  ],
  ["@hot-updater/analytics", "analytics"],
  ["@hot-updater/analytics/provider", "parseAnalyticsProvider"],
  ["@hot-updater/analytics/legacy-server", "createLegacyHotUpdater"],
  ["@hot-updater/better-auth", "betterAuthPlugin"],
  ["@hot-updater/standalone", "standaloneAnalytics"],
] as const;

const packedArtifactMatrix = [
  [
    "@hot-updater/plugin-core",
    [
      "dist/index.cjs",
      "dist/index.d.cts",
      "dist/index.d.mts",
      "dist/index.mjs",
      "dist/internal/capabilities.cjs",
      "dist/internal/capabilities.d.cts",
      "dist/internal/capabilities.d.mts",
      "dist/internal/capabilities.mjs",
    ],
  ],
  [
    "@hot-updater/server",
    [
      "dist/index.cjs",
      "dist/index.d.cts",
      "dist/index.d.mts",
      "dist/index.mjs",
      "dist/internal/first-party-plugin.cjs",
      "dist/internal/first-party-plugin.d.cts",
      "dist/internal/first-party-plugin.d.mts",
      "dist/internal/first-party-plugin.mjs",
    ],
  ],
  [
    "@hot-updater/analytics",
    [
      "dist/index.cjs",
      "dist/index.d.cts",
      "dist/index.d.mts",
      "dist/index.mjs",
      "dist/legacy-server/index.cjs",
      "dist/legacy-server/index.d.cts",
      "dist/legacy-server/index.d.mts",
      "dist/legacy-server/index.mjs",
      "dist/provider/index.cjs",
      "dist/provider/index.d.cts",
      "dist/provider/index.d.mts",
      "dist/provider/index.mjs",
      "dist/react-native/index.cjs",
      "dist/react-native/index.d.cts",
      "dist/react-native/index.d.mts",
      "dist/react-native/index.mjs",
    ],
  ],
  [
    "@hot-updater/better-auth",
    [
      "dist/index.cjs",
      "dist/index.d.cts",
      "dist/index.d.mts",
      "dist/index.mjs",
    ],
  ],
  [
    "@hot-updater/standalone",
    [
      "dist/index.cjs",
      "dist/index.d.cts",
      "dist/index.d.mts",
      "dist/index.mjs",
    ],
  ],
] satisfies readonly (readonly [string, readonly string[]])[];

const forbiddenPackedPath =
  /(^|\/)(src|[^/]*(?:spec|test)\.[^/]+|[^/]*fixture[^/]*)(\/|$)/i;

const consumerSource = `
import { analytics } from "@hot-updater/analytics";
import { parseAnalyticsProvider } from "@hot-updater/analytics/provider";
import { createLegacyHotUpdater } from "@hot-updater/analytics/legacy-server";
import {
  betterAuthPlugin,
  type BetterAuthSessionConfiguredInstance,
} from "@hot-updater/better-auth";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createHotUpdater,
  type HandlerRoutes,
} from "@hot-updater/server";
import { defineFirstPartyFeatureManifest } from "@hot-updater/server/internal/first-party-plugin";
import { standaloneAnalytics } from "@hot-updater/standalone";

declare const database: DatabasePlugin;
declare const sessionAuth: BetterAuthSessionConfiguredInstance;
const routes = {
  bundles: false,
  updateCheck: true,
} satisfies HandlerRoutes;
const manifest = analytics();
const standaloneManifest = standaloneAnalytics({
  baseUrl: "https://updates.example.com",
});
const sessionManifest = betterAuthPlugin({ auth: sessionAuth });
const runtime = createHotUpdater({ database, plugins: [manifest], routes });
void runtime.features.analytics.getBundleEventSummary;
void sessionManifest;
void standaloneManifest;
void parseAnalyticsProvider;
void createLegacyHotUpdater;
void defineFirstPartyFeatureManifest;
`;

beforeAll(async () => {
  consumer = await createPackedConsumer(packageDirectories);
}, 60_000);

afterAll(async () => {
  await consumer.dispose();
});

describe("packed server plugin package consumers", () => {
  it.each(packedArtifactMatrix)(
    "ships only built package content for %s",
    async (packageName, expectedArtifacts) => {
      const packageDirectory = consumer.packageDirectories.get(packageName);
      if (packageDirectory === undefined) {
        throw new TypeError(`Missing packed directory for ${packageName}.`);
      }
      const files = (await readdir(packageDirectory, { recursive: true }))
        .map((file) => file.split(path.sep).join("/"))
        .filter(
          (file) =>
            file !== "node_modules" && !file.startsWith("node_modules/"),
        )
        .sort();

      expect(files).toContain("package.json");
      expect(files.filter((file) => forbiddenPackedPath.test(file))).toEqual(
        [],
      );
      for (const artifact of expectedArtifacts) {
        expect(files).toContain(artifact);
      }
    },
  );

  it.each(exportedFunctions)(
    "loads %s through its ESM import condition",
    async (specifier, exportedFunction) => {
      await runNode(
        consumer.directory,
        `const runtime = await import(${JSON.stringify(specifier)});
if (typeof runtime[${JSON.stringify(exportedFunction)}] !== "function") {
  throw new TypeError("missing packed export");
}`,
        true,
      );
    },
  );

  it.each(exportedFunctions)(
    "loads %s through its CommonJS require condition",
    async (specifier, exportedFunction) => {
      await runNode(
        consumer.directory,
        `const runtime = require(${JSON.stringify(specifier)});
if (typeof runtime[${JSON.stringify(exportedFunction)}] !== "function") {
  throw new TypeError("missing packed export");
}`,
        false,
      );
    },
  );

  it.each(["consumer.mts", "consumer.cts"])(
    "type-checks %s through NodeNext declarations",
    async (file) => {
      const consumerFile = path.join(consumer.directory, file);
      await writeFile(consumerFile, consumerSource);
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

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
  [
    "@hot-updater/plugin-core/internal/config-feature-manifest",
    "isConfigFeatureManifest",
  ],
  ["@hot-updater/analytics", "analytics"],
  ["@hot-updater/analytics/legacy-server", "createLegacyHotUpdater"],
  ["@hot-updater/better-auth", "betterAuthPlugin"],
  ["@hot-updater/better-auth/managed", "managedBetterAuthPlugin"],
  [
    "@hot-updater/better-auth/managed/provisioning",
    "provisionManagedBetterAuthApiKey",
  ],
  ["@hot-updater/standalone", "standaloneRepository"],
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
      "dist/internal/config-feature-manifest.cjs",
      "dist/internal/config-feature-manifest.d.cts",
      "dist/internal/config-feature-manifest.d.mts",
      "dist/internal/config-feature-manifest.mjs",
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
      "dist/internal/provider-capability.cjs",
      "dist/internal/provider-capability.d.cts",
      "dist/internal/provider-capability.d.mts",
      "dist/internal/provider-capability.mjs",
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
      "dist/managed.cjs",
      "dist/managed.d.cts",
      "dist/managed.d.mts",
      "dist/managed.mjs",
      "dist/managed/provisioning.cjs",
      "dist/managed/provisioning.d.cts",
      "dist/managed/provisioning.d.mts",
      "dist/managed/provisioning.mjs",
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
import { createLegacyHotUpdater } from "@hot-updater/analytics/legacy-server";
import {
  betterAuthPlugin,
  type BetterAuthSessionConfiguredInstance,
} from "@hot-updater/better-auth";
import { managedBetterAuthPlugin } from "@hot-updater/better-auth/managed";
import {
  provisionManagedBetterAuthApiKey,
  type ProvisionedManagedBetterAuthApiKey,
} from "@hot-updater/better-auth/managed/provisioning";
import type { ConfigInput, DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createHotUpdater,
  type HandlerRoutes,
} from "@hot-updater/server";
import { defineFirstPartyFeatureManifest } from "@hot-updater/server/internal/first-party-plugin";
import { standaloneRepository } from "@hot-updater/standalone";

declare const database: DatabasePlugin;
declare const provisioned: ProvisionedManagedBetterAuthApiKey;
declare const sessionAuth: BetterAuthSessionConfiguredInstance;
const routes = {
  bundles: false,
  updateCheck: true,
} satisfies HandlerRoutes;
const manifest = analytics();
const standaloneDatabase = standaloneRepository({
  baseUrl: "https://updates.example.com",
});
const sessionManifest = betterAuthPlugin({ auth: sessionAuth });
const consoleConfig = {
  plugins: [manifest, sessionManifest],
} satisfies NonNullable<ConfigInput["console"]>;
const runtime = createHotUpdater({
  database: standaloneDatabase,
  plugins: [manifest],
  routes,
});
void runtime.features.analytics.getBundleEventSummary;
void consoleConfig;
void managedBetterAuthPlugin;
void provisionManagedBetterAuthApiKey;
void provisioned;
void sessionManifest;
void database;
void createLegacyHotUpdater;
void defineFirstPartyFeatureManifest;
`;

const mixedManifestConsumers = [
  {
    create: 'runtime.analytics({ queryAccess: "public" })',
    packageName: "@hot-updater/analytics",
  },
  {
    create:
      "runtime.betterAuthPlugin({ auth: { api: { getSession: async () => null } } })",
    packageName: "@hot-updater/better-auth",
  },
] as const;

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

  it.each(mixedManifestConsumers)(
    "recognizes a CommonJS $packageName manifest from the ESM server",
    async ({ create, packageName }) => {
      await runNode(
        consumer.directory,
        `import { createRequire } from "node:module";
import { isFirstPartyFeatureManifest } from "@hot-updater/server/internal/first-party-plugin";
const require = createRequire(import.meta.url);
const runtime = require(${JSON.stringify(packageName)});
if (!isFirstPartyFeatureManifest(${create})) {
  throw new TypeError("mixed CommonJS manifest brand was not recognized");
}`,
        true,
      );
    },
  );

  it("shares the Analytics transport capability across ESM and CommonJS", async () => {
    await runNode(
      consumer.directory,
      `import { createRequire } from "node:module";
import { analyticsProviderCapability as esmToken } from "@hot-updater/analytics/internal/provider-capability";
const require = createRequire(import.meta.url);
const { analyticsProviderCapability: cjsToken } = require("@hot-updater/analytics/internal/provider-capability");
if (esmToken !== cjsToken) {
  throw new TypeError("Analytics capability token identity diverged");
}`,
      true,
    );
  });

  it("composes a CommonJS Standalone repository with ESM Analytics", async () => {
    await runNode(
      consumer.directory,
      `import { createRequire } from "node:module";
import { analytics } from "@hot-updater/analytics";
import { createHotUpdater } from "@hot-updater/server";
const require = createRequire(import.meta.url);
const { standaloneRepository } = require("@hot-updater/standalone");
const runtime = createHotUpdater({
  database: standaloneRepository({ baseUrl: "https://updates.example.com" }),
  plugins: [analytics({ queryAccess: "public" })],
  routes: { bundles: false, updateCheck: false },
});
if (runtime.features.analytics.status !== "available") {
  throw new TypeError("Standalone Analytics capability was not resolved");
}`,
      true,
    );
  });

  it("composes an ESM Standalone repository with CommonJS Analytics", async () => {
    await runNode(
      consumer.directory,
      `(async () => {
  const { analytics } = require("@hot-updater/analytics");
  const { createHotUpdater } = require("@hot-updater/server");
  const { standaloneRepository } = await import("@hot-updater/standalone");
  const runtime = createHotUpdater({
    database: standaloneRepository({ baseUrl: "https://updates.example.com" }),
    plugins: [analytics({ queryAccess: "public" })],
    routes: { bundles: false, updateCheck: false },
  });
  if (runtime.features.analytics.status !== "available") {
    throw new TypeError("Standalone Analytics capability was not resolved");
  }
})();`,
      false,
    );
  });

  it.each(mixedManifestConsumers)(
    "recognizes an ESM $packageName manifest from the CommonJS server",
    async ({ create, packageName }) => {
      await runNode(
        consumer.directory,
        `const { isFirstPartyFeatureManifest } = require("@hot-updater/server/internal/first-party-plugin");
void import(${JSON.stringify(packageName)}).then((runtime) => {
  if (!isFirstPartyFeatureManifest(${create})) {
    throw new TypeError("mixed ESM manifest brand was not recognized");
  }
});`,
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

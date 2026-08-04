import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupPackedKernelPackages,
  type PackedPackageName,
  preparePackedKernelPackages,
  runPackedNode,
  typeCheckPackedConsumer,
} from "./kernelPackageConsumers.testFixtures";

type RuntimeEntrypoint = {
  readonly exportName: string;
  readonly name: PackedPackageName;
  readonly specifier: string;
};

const runtimeEntrypoints: readonly RuntimeEntrypoint[] = [
  {
    exportName: "attachCapabilityContribution",
    name: "pluginCore",
    specifier: "@hot-updater/plugin-core",
  },
  {
    exportName: "defineSharedCapability",
    name: "pluginCore",
    specifier: "@hot-updater/plugin-core/internal/capabilities",
  },
  {
    exportName: "createHotUpdater",
    name: "server",
    specifier: "@hot-updater/server",
  },
  {
    exportName: "defineFirstPartyServerPlugin",
    name: "server",
    specifier: "@hot-updater/server/internal/first-party-plugin",
  },
];

const databaseFixture = `const database = {
  name: "packed-consumer-database",
  create: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
  count: async () => 0,
  findOne: async () => null,
  findMany: async () => [],
};`;

beforeAll(preparePackedKernelPackages);
afterAll(cleanupPackedKernelPackages);

describe("packed Generic Kernel entrypoints", () => {
  it.each(runtimeEntrypoints)(
    "resolves $specifier to its ESM artifact",
    async ({ name, specifier }) => {
      const { stdout } = await runPackedNode(
        name,
        `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}));`,
        true,
      );

      expect(stdout).toMatch(/\.mjs$/);
    },
  );

  it.each(runtimeEntrypoints)(
    "resolves $specifier to its CommonJS artifact",
    async ({ name, specifier }) => {
      const { stdout } = await runPackedNode(
        name,
        `process.stdout.write(require.resolve(${JSON.stringify(specifier)}));`,
      );

      expect(stdout).toMatch(/\.cjs$/);
    },
  );

  it.each(runtimeEntrypoints)(
    "loads $exportName from $specifier through ESM import",
    async ({ exportName, name, specifier }) => {
      await runPackedNode(
        name,
        `const runtime = await import(${JSON.stringify(specifier)});
if (typeof runtime[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
        true,
      );
    },
  );

  it.each(runtimeEntrypoints)(
    "loads $exportName from $specifier through CommonJS require",
    async ({ exportName, name, specifier }) => {
      await runPackedNode(
        name,
        `const runtime = require(${JSON.stringify(specifier)});
if (typeof runtime[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
      );
    },
  );
});

describe("packed Generic Kernel declarations", () => {
  it.each(["mts", "cts"] as const)(
    "type-checks plugin-core %s consumers with NodeNext",
    async (extension) => {
      await typeCheckPackedConsumer(
        "pluginCore",
        `plugin-core-consumer.${extension}`,
        `import { attachCapabilityContribution } from "@hot-updater/plugin-core";
import { defineSharedCapability, getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
const token = defineSharedCapability({ id: "consumer.value@1", parse: String });
const carrier = attachCapabilityContribution({}, { token, create: () => "value" });
void getCapabilityContributions(carrier);`,
      );
    },
  );

  it.each(["mts", "cts"] as const)(
    "type-checks server %s consumers with NodeNext",
    async (extension) => {
      await typeCheckPackedConsumer(
        "server",
        `server-consumer.${extension}`,
        `import { createHotUpdater, type CreateHotUpdaterOptions } from "@hot-updater/server";
import { defineFirstPartyServerPlugin, type FirstPartyServerPlugin } from "@hot-updater/server/internal/first-party-plugin";
const plugin: FirstPartyServerPlugin = defineFirstPartyServerPlugin({ id: "consumer", setup: () => ({}), version: "1" });
const acceptOptions = (_options: CreateHotUpdaterOptions): void => undefined;
void acceptOptions;
void createHotUpdater;
void plugin;`,
      );
    },
  );
});

describe("packed Generic Kernel cross-condition authorities", () => {
  it("accepts an ESM-defined first-party plugin in CommonJS createHotUpdater", async () => {
    await runPackedNode(
      "server",
      `import { createRequire } from "node:module";
const { defineFirstPartyServerPlugin } = await import("@hot-updater/server/internal/first-party-plugin");
const { createHotUpdater } = createRequire(import.meta.url)("@hot-updater/server");
const plugin = defineFirstPartyServerPlugin({ id: "consumer", setup: () => ({}), version: "1" });
${databaseFixture}
const api = createHotUpdater({ database, plugins: [plugin] });
if (api.adapterName !== database.name) process.exit(1);`,
      true,
    );
  });

  it("accepts a CommonJS-defined first-party plugin in ESM createHotUpdater", async () => {
    await runPackedNode(
      "server",
      `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { defineFirstPartyServerPlugin } = require("@hot-updater/server/internal/first-party-plugin");
const { createHotUpdater } = await import("@hot-updater/server");
const plugin = defineFirstPartyServerPlugin({ id: "consumer", setup: () => ({}), version: "1" });
${databaseFixture}
const api = createHotUpdater({ database, plugins: [plugin] });
if (api.adapterName !== database.name) process.exit(1);`,
      true,
    );
  });

  it("shares capability token identity between ESM and CommonJS", async () => {
    await runPackedNode(
      "pluginCore",
      `import { createRequire } from "node:module";
const esm = await import("@hot-updater/plugin-core/internal/capabilities");
const commonjs = createRequire(import.meta.url)("@hot-updater/plugin-core/internal/capabilities");
const options = { id: "consumer.shared@1", parse: String };
if (esm.defineSharedCapability(options) !== commonjs.defineSharedCapability(options)) process.exit(1);`,
      true,
    );
  });

  it("recognizes an ESM carrier through the CommonJS capability authority", async () => {
    await runPackedNode(
      "pluginCore",
      `import { createRequire } from "node:module";
const esm = await import("@hot-updater/plugin-core");
const commonjs = createRequire(import.meta.url)("@hot-updater/plugin-core/internal/capabilities");
const token = commonjs.defineSharedCapability({ id: "consumer.carrier@1", parse: String });
const carrier = esm.attachCapabilityContribution({}, { token, create: () => "value" });
const contributions = commonjs.getCapabilityContributions(carrier);
if (contributions.length !== 1 || contributions[0].token !== token) process.exit(1);`,
      true,
    );
  });
});

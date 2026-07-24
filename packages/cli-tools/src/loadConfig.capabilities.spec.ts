import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let projectRoot = "";

vi.mock("./cwd.js", () => ({
  getCwd: () => projectRoot,
}));

const writeProjectFile = async (
  rootDir: string,
  relativePath: string,
  contents: string,
) => {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
};

const commonJsProviderSource = [
  "const { attachCapabilityContribution, defineCapability } = require('@hot-updater/plugin-core');",
  "const token = defineCapability({",
  "  id: 'transitive-cjs-test@1',",
  "  parse: (value) => value,",
  "});",
  "exports.createDatabase = () => attachCapabilityContribution({",
  "  name: 'transitive-cjs-database',",
  "  expectedToken: token,",
  "  create: async () => ({}),",
  "  update: async () => null,",
  "  delete: async () => undefined,",
  "  count: async () => 0,",
  "  findOne: async () => null,",
  "  findMany: async () => [],",
  "}, {",
  "  token,",
  "  create: () => ({ loaded: true }),",
  "});",
  "",
].join("\n");

describe("loadConfig capabilities", () => {
  beforeEach(async () => {
    vi.resetModules();
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-config-"),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    {
      extension: "ts",
      moduleLines: {
        exportDatabase: "export default { database };",
        importPluginCore:
          "import { attachCapabilityContribution, defineCapability } from '@hot-updater/plugin-core';",
      },
    },
    {
      extension: "mjs",
      moduleLines: {
        exportDatabase: "export default { database };",
        importPluginCore:
          "import { attachCapabilityContribution, defineCapability } from '@hot-updater/plugin-core';",
      },
    },
    {
      extension: "cjs",
      moduleLines: {
        exportDatabase: "module.exports = { database };",
        importPluginCore:
          "const { attachCapabilityContribution, defineCapability } = require('@hot-updater/plugin-core');",
      },
    },
  ])(
    "preserves database capability contributions from .$extension configs",
    async ({ extension, moduleLines }) => {
      await writeProjectFile(
        projectRoot,
        `hot-updater.config.${extension}`,
        [
          moduleLines.importPluginCore,
          "const token = defineCapability({",
          "  id: 'config-test@1',",
          "  parse: (value) => value,",
          "});",
          "const database = attachCapabilityContribution({",
          "  name: 'symbol-database',",
          "  expectedToken: token,",
          "  create: async () => ({}),",
          "  update: async () => null,",
          "  delete: async () => undefined,",
          "  count: async () => 0,",
          "  findOne: async () => null,",
          "  findMany: async () => [],",
          "}, {",
          "  token,",
          "  create: () => ({ loaded: true }),",
          "});",
          moduleLines.exportDatabase,
          "",
        ].join("\n"),
      );

      const { loadConfig } = await import("./loadConfig");
      const { getCapabilityContributions } =
        await import("@hot-updater/plugin-core/internal/capabilities");
      const config = await loadConfig(null);
      const [contribution] = getCapabilityContributions(config.database);

      expect(contribution?.token.id).toBe("config-test@1");
      expect(contribution?.token).toBe(
        (
          config.database as typeof config.database & {
            expectedToken: object;
          }
        ).expectedToken,
      );
    },
  );

  it.each([
    {
      configLines: [
        "const { createDatabase } = require('./provider.cjs');",
        "module.exports = { database: createDatabase() };",
      ],
      kind: "eager",
    },
    {
      configLines: [
        "module.exports = () => {",
        "  const { createDatabase } = require('./provider.cjs');",
        "  return { database: createDatabase() };",
        "};",
      ],
      kind: "functional",
    },
  ])(
    "preserves contributions from a $kind transitive CommonJS provider",
    async ({ configLines }) => {
      await writeProjectFile(
        projectRoot,
        "provider.cjs",
        commonJsProviderSource,
      );
      await writeProjectFile(
        projectRoot,
        "hot-updater.config.cjs",
        [...configLines, ""].join("\n"),
      );

      const require = createRequire(import.meta.url);
      const requiredPluginCoreBefore = require("@hot-updater/plugin-core");
      const requiredAnalyticsBefore = require("@hot-updater/analytics/provider");
      const { loadConfig } = await import("./loadConfig");
      const { getCapabilityContributions } =
        await import("@hot-updater/plugin-core/internal/capabilities");
      const config = await loadConfig(null);
      const [contribution] = getCapabilityContributions(config.database);

      expect(contribution?.token.id).toBe("transitive-cjs-test@1");
      expect(contribution?.token).toBe(
        (
          config.database as typeof config.database & {
            expectedToken: object;
          }
        ).expectedToken,
      );
      expect(require("@hot-updater/plugin-core")).toBe(
        requiredPluginCoreBefore,
      );
      expect(require("@hot-updater/analytics/provider")).toBe(
        requiredAnalyticsBefore,
      );
    },
  );

  it("restores module caches when config evaluation fails", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.cjs",
      "throw new Error('config failed');\n",
    );
    const require = createRequire(import.meta.url);
    const pluginCoreBefore = require("@hot-updater/plugin-core");
    const analyticsBefore = require("@hot-updater/analytics/provider");
    const { loadConfig } = await import("./loadConfig");

    await expect(loadConfig(null)).rejects.toThrow("config failed");

    expect(require("@hot-updater/plugin-core")).toBe(pluginCoreBefore);
    expect(require("@hot-updater/analytics/provider")).toBe(analyticsBefore);
  });

  it("serializes concurrent functional config evaluation", async () => {
    await writeProjectFile(projectRoot, "provider.cjs", commonJsProviderSource);
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.cjs",
      [
        "globalThis.__hotUpdaterActiveConfigLoads ??= 0;",
        "module.exports = async () => {",
        "  globalThis.__hotUpdaterActiveConfigLoads += 1;",
        "  const overlapped = globalThis.__hotUpdaterActiveConfigLoads > 1;",
        "  await new Promise((resolve) => setImmediate(resolve));",
        "  const { createDatabase } = require('./provider.cjs');",
        "  globalThis.__hotUpdaterActiveConfigLoads -= 1;",
        "  return {",
        "    database: createDatabase(),",
        "    releaseChannel: overlapped ? 'overlapped' : 'serialized',",
        "  };",
        "};",
        "",
      ].join("\n"),
    );
    const { loadConfig } = await import("./loadConfig");

    const configs = await Promise.all([loadConfig(null), loadConfig(null)]);

    expect(configs.map(({ releaseChannel }) => releaseChannel)).toEqual([
      "serialized",
      "serialized",
    ]);
  });
});

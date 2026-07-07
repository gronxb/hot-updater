import fs from "fs/promises";
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

const databaseCoreSource = [
  "const createCore = () => ({",
  "  bundles: {",
  "    async getById() { return null; },",
  "    async findMany() { return []; },",
  "    async count() { return 0; },",
  "    async insert() {},",
  "    async update() {},",
  "    async delete() {},",
  "  },",
  "  bundlePatches: {",
  "    async findMany() { return []; },",
  "    async count() { return 0; },",
  "    async getById() { return null; },",
  "    async insert() {},",
  "    async update() {},",
  "    async delete() {},",
  "  },",
  "});",
] as const;

describe("loadConfig database runtime normalization", () => {
  beforeEach(async () => {
    vi.resetModules();
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-config-database-"),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("wraps a direct database runtime as a reusable opener", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { createDatabasePlugin } from '@hot-updater/plugin-core';",
        "",
        ...databaseCoreSource,
        "",
        "const database = createDatabasePlugin({",
        "  name: 'directDatabase',",
        "  connect: createCore,",
        "})({});",
        "",
        "export default { database };",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(typeof config.database).toBe("function");
    const firstRuntime = await config.database();
    const secondRuntime = await config.database();

    expect(firstRuntime.name).toBe("directDatabase");
    expect(secondRuntime.name).toBe("directDatabase");
    expect(secondRuntime).not.toBe(firstRuntime);
  });

  it("wraps a promise-like direct database runtime", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { createDatabasePlugin } from '@hot-updater/plugin-core';",
        "",
        ...databaseCoreSource,
        "",
        "const databasePlugin = createDatabasePlugin({",
        "  name: 'asyncDirectDatabase',",
        "  async connect() {",
        "    return createCore();",
        "  },",
        "});",
        "",
        "export default { database: databasePlugin({}) };",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    const database = await config.database();

    expect(database.name).toBe("asyncDirectDatabase");
  });
});

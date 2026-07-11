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
  "    async findRecords() { return []; },",
  "    async insert() {},",
  "    async update() {},",
  "    async delete() {},",
  "  },",
  "  patches: {",
  "    storage: 'rows',",
  "    async findRows() { return []; },",
  "    async getRowById() { return null; },",
  "    async insertRow() {},",
  "    async updateRow() {},",
  "    async deleteRow() {},",
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
        "import { createDatabasePlugin } from '@hot-updater/plugin-core/internal';",
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

  it("disposes the direct owner behind concurrently reopened borrowed runtimes", async () => {
    // Given
    const closeMarker = path.join(projectRoot, "database-closed.txt");
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { appendFile } from 'node:fs/promises';",
        "import { createDatabasePlugin } from '@hot-updater/plugin-core/internal';",
        "",
        ...databaseCoreSource,
        "",
        "const database = createDatabasePlugin({",
        "  name: 'ownedDatabase',",
        "  connect() {",
        "    return {",
        "      ...createCore(),",
        `      close: async () => appendFile(${JSON.stringify(closeMarker)}, 'closed\\n'),`,
        "    };",
        "  },",
        "})({});",
        "",
        "export default { database };",
        "",
      ].join("\n"),
    );

    // When
    const { disposeLoadedDatabase, loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);
    const [firstRuntime, secondRuntime] = await Promise.all([
      config.database(),
      config.database(),
    ]);

    // Then
    expect(firstRuntime).not.toBe(secondRuntime);
    expect(firstRuntime.close).toBeUndefined();
    expect(secondRuntime.close).toBeUndefined();
    await Promise.all([
      disposeLoadedDatabase(firstRuntime),
      disposeLoadedDatabase(secondRuntime),
    ]);
    await expect(fs.readFile(closeMarker, "utf-8")).resolves.toBe("closed\n");
  });

  it("reuses a factory-free direct runtime without redefining its disposer", async () => {
    // Given
    const closeMarker = path.join(projectRoot, "direct-runtime-closed.txt");
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { appendFile } from 'node:fs/promises';",
        "",
        "const database = {",
        "  name: 'factoryFreeDatabase',",
        "  bundles: {},",
        "  bundlePatches: {},",
        "  async commit() {},",
        `  async close() { await appendFile(${JSON.stringify(closeMarker)}, 'closed\\n'); },`,
        "};",
        "",
        "export default { database: () => database };",
        "",
      ].join("\n"),
    );

    // When
    const { disposeLoadedDatabase, loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);
    const firstRuntime = await config.database();
    const secondRuntime = await config.database();
    await Promise.all([
      disposeLoadedDatabase(firstRuntime),
      disposeLoadedDatabase(secondRuntime),
    ]);

    // Then
    expect(secondRuntime).toBe(firstRuntime);
    await expect(fs.readFile(closeMarker, "utf-8")).resolves.toBe("closed\n");
  });

  it("closes each fresh factory owner after reopening", async () => {
    // Given
    const closeMarker = path.join(projectRoot, "reopened-owner-closed.txt");
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { appendFile } from 'node:fs/promises';",
        "import { createDatabasePlugin } from '@hot-updater/plugin-core/internal';",
        "",
        ...databaseCoreSource,
        "",
        "const databasePlugin = createDatabasePlugin({",
        "  name: 'reopenedDatabase',",
        "  connect() {",
        "    return {",
        "      ...createCore(),",
        `      close: async () => appendFile(${JSON.stringify(closeMarker)}, 'closed\\n'),`,
        "    };",
        "  },",
        "});",
        "",
        "export default { database: () => databasePlugin({}) };",
        "",
      ].join("\n"),
    );

    // When
    const { disposeLoadedDatabase, loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);
    const firstRuntime = await config.database();
    await disposeLoadedDatabase(firstRuntime);
    const firstLifecycle = await fs.readFile(closeMarker, "utf-8");
    const secondRuntime = await config.database();
    await disposeLoadedDatabase(secondRuntime);

    // Then
    expect(firstRuntime.close).toBeUndefined();
    expect(secondRuntime.close).toBeUndefined();
    expect(firstLifecycle).toBe("closed\n");
    await expect(fs.readFile(closeMarker, "utf-8")).resolves.toBe(
      "closed\nclosed\n",
    );
  });

  it("wraps a promise-like direct database runtime", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { createDatabasePlugin } from '@hot-updater/plugin-core/internal';",
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

  it("loads the default Cloudflare database from Node credentials", async () => {
    // Given
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "import { d1Database } from '@hot-updater/cloudflare';",
        "",
        "export default {",
        "  database: d1Database({",
        "    accountId: 'account-id',",
        "    cloudflareApiToken: 'api-token',",
        "    databaseId: 'database-id',",
        "  }),",
        "};",
        "",
      ].join("\n"),
    );

    // When
    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);
    const database = await config.database();

    // Then
    expect(database.name).toBe("kysely");
    expect("adapterName" in database ? database.adapterName : undefined).toBe(
      "kysely",
    );
    expect("provider" in database ? database.provider : undefined).toBe(
      "sqlite",
    );
    await database.close?.();
  });
});

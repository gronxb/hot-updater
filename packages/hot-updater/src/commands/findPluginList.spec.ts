import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { findPluginList } from "./pluginCommands";

// The banner reads the CLI's package.json through a build-time alias.
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-plugin-list-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

it("finds no plugin list in a project without a server definition", async () => {
  await expect(findPluginList([], cwd)).resolves.toBeUndefined();
});

it("reads the plugins of the server definition hot-updater.config.ts points at", async () => {
  // The definition imports @hot-updater/server from the project.
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(cwd, "node_modules"),
  );
  await writeFile(
    path.join(cwd, "hot-updater.config.ts"),
    'export default { server: "./hotUpdater.ts" };\n',
  );
  await writeFile(
    path.join(cwd, "hotUpdater.ts"),
    [
      'import { createHotUpdater } from "@hot-updater/server";',
      'import { createMemoryAdapter } from "@hot-updater/plugin-core";',
      "",
      "export const hotUpdater = createHotUpdater({",
      '  database: { name: "memory", adapter: createMemoryAdapter() },',
      '  plugins: [{ id: "notes", schemaVersion: "1", schema: {}, init: () => ({ api: {} }) }],',
      '  clientAccess: "public",',
      "});",
      "",
    ].join("\n"),
  );
  vi.spyOn(process, "cwd").mockReturnValue(cwd);

  const found = await findPluginList([], cwd);

  expect(found?.from).toBe("hotUpdater.ts");
  expect(found?.plugins.map((plugin) => (plugin as { id: string }).id)).toEqual(
    ["notes"],
  );
});

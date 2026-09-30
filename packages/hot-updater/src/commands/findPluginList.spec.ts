import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await rm(cwd, { recursive: true, force: true });
});

it("finds no plugin list in a project without a server config or hotUpdater.plugins.ts", async () => {
  await expect(findPluginList([], cwd)).resolves.toBeUndefined();
});

it("reads the plugins hotUpdater.plugins.ts exports", async () => {
  await writeFile(
    path.join(cwd, "hotUpdater.plugins.ts"),
    'export const plugins = [{ id: "notes", schemaVersion: "1", schema: {}, init: () => ({ api: {} }) }];\n',
  );

  const found = await findPluginList([], cwd);

  expect(found?.from).toBe("hotUpdater.plugins.ts");
  expect(found?.plugins.map((plugin) => (plugin as { id: string }).id)).toEqual(
    ["notes"],
  );
});

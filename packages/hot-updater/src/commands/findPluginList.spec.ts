import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { findPluginList } from "./utils/load-hot-updater";

let cwd: string;

/** A module that exports a server definition whose plugins have these ids. */
const definition = (...ids: string[]) =>
  [
    "export const hotUpdater = {",
    '  database: { name: "memory" },',
    "  storage: [],",
    `  plugins: ${JSON.stringify(ids.map((id) => ({ id })))},`,
    "  clientPlugins: [],",
    "  clientEndpoints: [],",
    "  core: {},",
    "  api: {},",
    "};",
    "",
  ].join("\n");

const write = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), text);
};

const ids = (found: Awaited<ReturnType<typeof findPluginList>>) =>
  found?.plugins.map(({ id }) => id);

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-plugin-list-"));
  // hot-updater.config.ts is found from the working directory.
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

it("finds no plugin list in a project without a server definition or config plugins", async () => {
  await expect(findPluginList([], cwd)).resolves.toBeUndefined();
});

it("reads the plugins hot-updater.config.ts lists, closing the database it opened", async () => {
  const disposed = path.join(cwd, "disposed");
  await write(
    "hot-updater.config.ts",
    [
      'import { writeFileSync } from "node:fs";',
      "export default {",
      "  database: {",
      '    name: "memory",',
      "    adapter: {},",
      `    dispose: async () => writeFileSync(${JSON.stringify(disposed)}, ""),`,
      "  },",
      '  plugins: [{ id: "notes" }],',
      "};",
      "",
    ].join("\n"),
  );
  await write("src/hotUpdater.ts", definition("other"));

  const found = await findPluginList([], cwd);

  expect(found?.from).toBe("hot-updater.config.ts");
  expect(ids(found)).toEqual(["notes"]);
  expect(existsSync(disposed)).toBe(true);
});

it("reads the server definition the arguments name before hot-updater.config.ts", async () => {
  await write(
    "hot-updater.config.ts",
    'export default { plugins: [{ id: "notes" }] };\n',
  );
  await write("server/hotUpdater.ts", definition("named"));

  const found = await findPluginList(["--yes", "server/hotUpdater.ts"], cwd);

  expect(found?.from).toBe(path.join("server", "hotUpdater.ts"));
  expect(ids(found)).toEqual(["named"]);
});

it("reads src/hotUpdater.ts when hot-updater.config.ts lists no plugins", async () => {
  await write("hot-updater.config.ts", "export default {};\n");
  await write("src/hotUpdater.ts", definition("insights"));

  const found = await findPluginList([], cwd);

  expect(found?.from).toBe(path.join("src", "hotUpdater.ts"));
  expect(ids(found)).toEqual(["insights"]);
});

it("reports a default definition that fails to load, and reads the next one", async () => {
  await write(
    "src/hotUpdater.ts",
    'throw new Error("The definition failed to load.");\n',
  );
  await write("src/db.ts", definition("apiKeys"));
  const failures: string[] = [];

  const found = await findPluginList([], cwd, failures);

  expect(found?.from).toBe(path.join("src", "db.ts"));
  expect(ids(found)).toEqual(["apiKeys"]);
  expect(failures).toEqual([
    `${path.join("src", "hotUpdater.ts")}: The definition failed to load.`,
  ]);
});

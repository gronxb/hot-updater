import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { importServerModule } from "./serverModule";

const tempDirs: string[] = [];

const writeModule = async (text: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-server-"));
  tempDirs.push(dir);
  const file = path.join(dir, "hotUpdater.ts");
  await fs.writeFile(file, text, "utf-8");
  return file;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("importServerModule", () => {
  it("reads the module's hotUpdater export and runs its closeDatabase", async () => {
    const file = await writeModule(
      [
        "export const hotUpdater = { adapterName: 'memory' };",
        "export const closeDatabase = async () => {",
        "  (globalThis as Record<string, unknown>).__closed = true;",
        "};",
      ].join("\n"),
    );

    const server = await importServerModule(file);

    expect(server.path).toBe(file);
    expect(server.hotUpdater).toEqual({ adapterName: "memory" });
    await expect(server.closeDatabase()).resolves.toBe(true);
    expect(Reflect.get(globalThis, "__closed")).toBe(true);
    Reflect.deleteProperty(globalThis, "__closed");
  });

  it("falls back to the default export, and has nothing to close without closeDatabase", async () => {
    const server = await importServerModule(
      await writeModule("export default { adapterName: 'memory' };"),
    );

    expect(server.hotUpdater).toEqual({ adapterName: "memory" });
    await expect(server.closeDatabase()).resolves.toBe(false);
  });
});

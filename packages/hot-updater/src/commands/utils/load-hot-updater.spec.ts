import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

const mockCli = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: {
    log: mockCli.log,
  },
}));

describe("loadHotUpdater", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps a missing generated Drizzle schema when allowed", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-load-config-"),
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "drizzle.ts"),
      [
        'import * as schema from "../hot-updater-schema";',
        "export const schemaKeys = Object.keys(schema);",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      [
        'import "./drizzle";',
        "export const hotUpdater = {",
        '  adapterName: "drizzle",',
        "};",
      ].join("\n"),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaPlaceholder: true,
      });
      expect(loaded.adapterName).toBe("drizzle");

      const placeholderPath = path.join(projectDir, "hot-updater-schema.ts");
      expect(await readFile(placeholderPath, "utf-8")).toContain(
        "Temporary placeholder",
      );

      await loaded.dispose();

      await expect(readFile(placeholderPath, "utf-8")).rejects.toThrow();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("removes the generated schema placeholder before exiting on invalid config", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-invalid-config-"),
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "drizzle.ts"),
      ['import "../hot-updater-schema";'].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      ['import "./drizzle";', 'export const value = "invalid";'].join("\n"),
      "utf-8",
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        loadHotUpdater("src/db.ts", {
          cwd: projectDir,
          allowGeneratedSchemaPlaceholder: true,
        }),
      ).rejects.toThrow("process.exit(1)");

      await expect(
        readFile(path.join(projectDir, "hot-updater-schema.ts"), "utf-8"),
      ).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

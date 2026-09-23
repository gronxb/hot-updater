import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  renderHotUpdaterPlugins,
  writeHotUpdaterPlugins,
} from "./hotUpdaterPlugins";

describe("writeHotUpdaterPlugins", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-plugins-"),
    );
    filePath = path.join(directory, "hotUpdater.plugins.ts");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("re-exports the provider's fixed plugin list", async () => {
    await expect(
      writeHotUpdaterPlugins("@hot-updater/aws", filePath),
    ).resolves.toEqual({ status: "created", path: filePath });

    const text = await fs.readFile(filePath, "utf-8");
    expect(text).toBe(renderHotUpdaterPlugins("@hot-updater/aws"));
    expect(text).toContain('export { plugins } from "@hot-updater/aws";');
  });

  it("leaves a generated file as it is on a second init", async () => {
    await writeHotUpdaterPlugins("@hot-updater/supabase", filePath);

    await expect(
      writeHotUpdaterPlugins("@hot-updater/supabase", filePath),
    ).resolves.toEqual({ status: "unchanged", path: filePath });
  });

  it("keeps an edited file and says how to restore it", async () => {
    const edited = "export const plugins = [];\n";
    await fs.writeFile(filePath, edited, "utf-8");

    const result = await writeHotUpdaterPlugins(
      "@hot-updater/firebase",
      filePath,
    );

    expect(result).toMatchObject({ status: "skipped", path: filePath });
    expect(result.status === "skipped" && result.reason).toContain(
      'export { plugins } from "@hot-updater/firebase";',
    );
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(edited);
  });
});

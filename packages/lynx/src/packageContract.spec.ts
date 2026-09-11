import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("framework-independent Lynx package contract", () => {
  it("has no required React, Vue, or Octane dependency, peer, or compiler plugin", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      exports: Record<string, unknown>;
    };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    expect(names).toEqual([
      "@hot-updater/core",
      "@hot-updater/plugin-core",
      "uuidv7",
    ]);
    expect(names.join(" ")).not.toMatch(/react|vue|octane/i);
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./build");
  });

  it("keeps runtime import inert and reports native-absent failure from the built entry", async () => {
    const runtime = path.join(packageRoot, "dist/index.mjs");
    const build = path.join(packageRoot, "dist/build.mjs");
    expect(await fs.stat(runtime).then((value) => value.isFile())).toBe(true);
    expect(await fs.stat(build).then((value) => value.isFile())).toBe(true);
    const { createHotUpdater } = await import(runtime);
    const updater = createHotUpdater({ baseURL: "https://updates.test" });
    await expect(updater.getLaunchInfo()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
    await expect(updater.notifyAppReady()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
    const { lynx } = await import(build);
    expect(typeof lynx).toBe("function");
  });
});

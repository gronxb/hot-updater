import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("framework-independent Lynx package contract", () => {
  it("exports only the device root with no compiler, server, or Sparkling dependency", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    expect(manifest.dependencies).toEqual({
      "@hot-updater/protocol": "workspace:*",
    });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./package.json",
    ]);
  });

  it("keeps the public runtime import inert and reports a missing native module", async () => {
    const { HotUpdater } = await import("@hot-updater/lynx");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.getLaunchInfo()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
    await expect(HotUpdater.notifyAppReady()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
  });
});

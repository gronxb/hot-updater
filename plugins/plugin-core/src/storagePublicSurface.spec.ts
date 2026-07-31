import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRuntimeStoragePlugin } from "./createStoragePlugin";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const expectedPackageExports = {
  "plugins/plugin-core": [
    ".",
    "./internal/capabilities",
    "./internal/config-feature-manifest",
    "./package.json",
  ],
  "plugins/aws": [
    ".",
    "./iac",
    "./init",
    "./lambda",
    "./lambda/handler",
    "./package.json",
  ],
  "plugins/cloudflare": [
    ".",
    "./iac",
    "./init",
    "./package.json",
    "./worker",
    "./worker/config",
    "./worker/wrangler.json",
  ],
  "plugins/firebase": [
    ".",
    "./functions",
    "./functions/handler",
    "./iac",
    "./init",
    "./package.json",
  ],
  "plugins/supabase": [
    ".",
    "./edge",
    "./iac",
    "./init",
    "./package.json",
    "./scaffold",
  ],
  "plugins/mock": [".", "./package.json"],
  "plugins/standalone": [".", "./package.json"],
} as const;

const readWorkspaceFile = (filePath: string) =>
  readFile(path.join(workspaceRoot, filePath), "utf8");

describe("storage public surface", () => {
  it("keeps every package export path unchanged", async () => {
    for (const [packageDirectory, expectedExports] of Object.entries(
      expectedPackageExports,
    )) {
      const manifest: unknown = JSON.parse(
        await readWorkspaceFile(`${packageDirectory}/package.json`),
      );
      if (typeof manifest !== "object" || manifest === null) {
        throw new TypeError(`${packageDirectory} has an invalid package.json`);
      }
      const exportsField = Reflect.get(manifest, "exports");
      if (typeof exportsField !== "object" || exportsField === null) {
        throw new TypeError(`${packageDirectory} has invalid package exports`);
      }

      expect(Object.keys(exportsField).sort()).toEqual(
        [...expectedExports].sort(),
      );
    }
  });

  it("does not export the implementation authoring contract from plugin-core", async () => {
    const publicSources = await Promise.all([
      readWorkspaceFile("plugins/plugin-core/src/index.ts"),
      readWorkspaceFile("plugins/plugin-core/src/createStoragePlugin.ts"),
    ]);

    expect(publicSources.join("\n")).not.toMatch(
      /(?:from|export\s+\*)\s+["']\.\/storage["']/u,
    );
  });

  it("keeps the plugin object and factory timing unchanged", async () => {
    const implementation = {
      getDownloadUrl: vi.fn(async () => ({
        fileUrl: "https://assets.example.com/bundle.zip",
      })),
      readText: vi.fn(async () => null),
    };
    const factory = vi.fn(() => implementation);
    const plugin = createRuntimeStoragePlugin({
      name: "runtimeStorage",
      supportedProtocol: "storage",
      factory,
    })({})();

    expect(Reflect.ownKeys(plugin)).toEqual([
      "name",
      "supportedProtocol",
      "profiles",
    ]);
    expect(factory).not.toHaveBeenCalled();
    await expect(
      plugin.profiles.runtime.readText("storage://bucket/manifest.json"),
    ).resolves.toBeNull();
    expect(factory).toHaveBeenCalledOnce();
    expect(implementation.readText).toHaveBeenCalledOnce();
  });

  it("keeps former classification labels out of runtime code", async () => {
    const runtimeSources = await Promise.all([
      readWorkspaceFile("plugins/plugin-core/src/createStoragePlugin.ts"),
      readWorkspaceFile("packages/server/src/storageAccess.ts"),
    ]);
    const forbiddenLabels = [
      ["leg", "acy"].join(""),
      ["di", "rect"].join(""),
      ["v", "2"].join(""),
    ];

    for (const label of forbiddenLabels) {
      expect(runtimeSources.join("\n").toLowerCase()).not.toContain(label);
    }
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getReactNativeMetadatas } from "./getReactNativeMetadatas";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("getReactNativeMetadatas", () => {
  it.each(["./index.js", "./src/index.js", null])(
    "finds the hoisted package root with runtime entry %s",
    async (entry) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rn-metadata-"));
      tempDirs.push(root);
      const cwd = path.join(root, "apps/mobile");
      const packagePath = path.join(root, "node_modules/react-native");
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(packagePath, { recursive: true });
      await fs.writeFile(
        path.join(packagePath, "package.json"),
        JSON.stringify({
          name: "react-native",
          version: "0.85.2",
          exports: {
            ...(entry ? { ".": entry } : {}),
            "./package.json": "./package.json",
          },
        }),
      );
      if (entry) {
        await fs.mkdir(path.dirname(path.join(packagePath, entry)), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(packagePath, entry),
          "throw new Error('metadata must not execute React Native');",
        );
      }

      expect(getReactNativeMetadatas(cwd)).toEqual({
        packagePath: await fs.realpath(packagePath),
        versionRaw: "0.85.2",
        version: { major: 0, minor: 85, patch: 2 },
      });
    },
  );
});

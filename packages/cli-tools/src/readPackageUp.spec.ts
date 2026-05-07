import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPackageUp } from "./readPackageUp";

let tempDir = "";

describe("readPackageUp", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-read-closest-package-json-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("finds the nearest package.json from a nested directory", async () => {
    const packageJsonPath = path.join(tempDir, "package.json");
    const nestedDir = path.join(tempDir, "apps", "example", "src");

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: "example-app",
          dependencies: {
            react: "19.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(readPackageUp(nestedDir)).resolves.toEqual({
      packageJson: {
        name: "example-app",
        dependencies: {
          react: "19.0.0",
        },
      },
      path: packageJsonPath,
    });
  });

  it("returns undefined when no package.json exists up to the filesystem root", async () => {
    const nestedDir = path.join(tempDir, "apps", "example", "src");

    await fs.mkdir(nestedDir, { recursive: true });

    await expect(readPackageUp(nestedDir)).resolves.toBeUndefined();
  });
});

import fs from "fs/promises";
import path from "node:path";
import os from "os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePackageVersion } from "./resolvePackageVersion";

let tempDir = "";

const writePackage = async ({
  name,
  version,
  exports,
  entryFile,
  nestedPackageJson,
}: {
  name: string;
  version: string;
  exports: Record<string, string>;
  entryFile: string;
  nestedPackageJson?: {
    path: string;
    contents: Record<string, unknown>;
  };
}) => {
  const packageDir = path.join(tempDir, "node_modules", name);
  await fs.mkdir(path.join(packageDir, path.dirname(entryFile)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name, version, type: "module", exports }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(packageDir, entryFile), "export default {};\n");

  if (nestedPackageJson) {
    await fs.mkdir(
      path.join(packageDir, path.dirname(nestedPackageJson.path)),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(packageDir, nestedPackageJson.path),
      `${JSON.stringify(nestedPackageJson.contents, null, 2)}\n`,
    );
  }
};

describe("resolvePackageVersion", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-resolve-package-version-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads package.json directly when the subpath is exported", async () => {
    await writePackage({
      name: "exported-package-json",
      version: "1.2.3",
      exports: {
        ".": "./index.js",
        "./package.json": "./package.json",
      },
      entryFile: "index.js",
    });

    expect(
      resolvePackageVersion("exported-package-json", {
        searchFrom: tempDir,
      }),
    ).toBe("1.2.3");
  });

  it("falls back to the package entry when package.json is not exported", async () => {
    await writePackage({
      name: "entry-only-package",
      version: "4.5.6",
      exports: {
        ".": "./dist/index.js",
      },
      entryFile: "dist/index.js",
      nestedPackageJson: {
        path: "dist/package.json",
        contents: {
          type: "commonjs",
        },
      },
    });

    expect(
      resolvePackageVersion("entry-only-package", {
        searchFrom: tempDir,
      }),
    ).toBe("4.5.6");
  });
});

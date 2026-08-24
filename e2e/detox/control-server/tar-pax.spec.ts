import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { createTarBrTargetFiles } from "../../../packages/cli-tools/src/createTarBr.ts";
import { PAX_LONG_ASSET_ANDROID_MANIFEST_PATH } from "../pax-long-path-fixture.ts";
import { readPaxPaths } from "./tar-pax.ts";

const createdDirectories: string[] = [];

describe("readPaxPaths", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { force: true, recursive: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("finds the long Android asset path emitted by the production TAR writer", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-pax-e2e-"),
    );
    createdDirectories.push(directory);
    const sourcePath = path.join(directory, "asset.bmp");
    const archivePath = path.join(directory, "bundle.tar.br");
    await fs.writeFile(sourcePath, "pax fixture");

    await createTarBrTargetFiles({
      outfile: archivePath,
      targetFiles: [
        {
          name: PAX_LONG_ASSET_ANDROID_MANIFEST_PATH,
          path: sourcePath,
        },
      ],
    });

    expect(
      Buffer.byteLength(
        path.posix.basename(PAX_LONG_ASSET_ANDROID_MANIFEST_PATH),
      ),
    ).toBeGreaterThan(100);
    expect(
      readPaxPaths(brotliDecompressSync(await fs.readFile(archivePath))),
    ).toContain(PAX_LONG_ASSET_ANDROID_MANIFEST_PATH);
  });
});

import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { getFileHashFromFile } from "./getFileHash";

const createdDirectories: string[] = [];

describe("getFileHashFromFile", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("hashes file contents without requiring callers to load the file", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-file-hash-"),
    );
    createdDirectories.push(directory);

    const filePath = path.join(directory, "asset.bin");
    const content = Buffer.concat([
      Buffer.from("asset-start"),
      Buffer.alloc(1024 * 64, "a"),
      Buffer.from("asset-end"),
    ]);
    await fs.writeFile(filePath, content);

    await expect(getFileHashFromFile(filePath)).resolves.toBe(
      crypto.createHash("sha256").update(content).digest("hex"),
    );
  });
});

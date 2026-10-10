import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStorageAdapter } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getStorageFileByteSize, putStorageFile } from "./storageFiles";

const temporaryDirectories: string[] = [];

const createLargeFile = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storage-files-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "bundle with spaces.zip");
  const file = await fs.open(filePath, "w");
  const chunk = new Uint8Array(64 * 1024).fill(42);

  try {
    for (let index = 0; index < 32; index += 1) {
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }

  return { filePath, size: chunk.byteLength * 32 };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("putStorageFile", () => {
  it("streams a large file and reports its content length", async () => {
    const { filePath, size } = await createLargeFile();
    let firstChunkSize = 0;

    const storage = createStorageAdapter({
      name: "streaming-test",
      protocol: "test",
      async put({ body, contentLength, contentType, key }) {
        expect(body).toBeInstanceOf(ReadableStream);
        expect(contentLength).toBe(size);
        expect(contentType).toBe("application/zip");
        expect(key).toBe("releases/bundle with spaces.zip");

        const reader = body.getReader();
        const first = await reader.read();
        firstChunkSize = first.value?.byteLength ?? 0;
        await reader.cancel();

        return { storageUri: "test://bucket/releases/bundle.zip" };
      },
    });

    await expect(
      putStorageFile(storage, "releases", filePath),
    ).resolves.toEqual({
      byteSize: size,
      storageUri: "test://bucket/releases/bundle.zip",
    });

    expect(firstChunkSize).toBeGreaterThan(0);
    expect(firstChunkSize).toBeLessThan(size);
  });

  it("rejects a file size that cannot be represented exactly", async () => {
    const stat = vi.spyOn(fs, "stat").mockResolvedValueOnce({
      size: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    } as never);

    try {
      await expect(getStorageFileByteSize("too-large.zip")).rejects.toThrow(
        "non-negative safe integer",
      );
      expect(stat).toHaveBeenCalledWith("too-large.zip", { bigint: true });
    } finally {
      stat.mockRestore();
    }
  });
});

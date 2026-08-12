import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStoragePlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { putStorageFile, writeStorageFile } from "./storageFiles";

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

    const storage = createStoragePlugin({
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
      storageUri: "test://bucket/releases/bundle.zip",
    });

    expect(firstChunkSize).toBeGreaterThan(0);
    expect(firstChunkSize).toBeLessThan(size);
  });
});

describe("writeStorageFile", () => {
  it("streams a response body to a file without using arrayBuffer", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "storage-files-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "nested", "bundle.zip");
    const chunk = new Uint8Array(64 * 1024).fill(23);
    const chunkCount = 32;
    let emitted = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted === chunkCount) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          emitted += 1;
        },
      }),
    );
    const arrayBuffer = vi
      .spyOn(response, "arrayBuffer")
      .mockRejectedValue(new Error("arrayBuffer must not be used"));
    const storage = createStoragePlugin({
      name: "streaming-test",
      protocol: "test",
      get: async () => ({ response }),
    });

    await writeStorageFile(storage, "test://bucket/bundle.zip", filePath);

    expect((await fs.stat(filePath)).size).toBe(chunk.byteLength * chunkCount);
    expect(emitted).toBe(chunkCount);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("creates an empty file when the response has no body", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "storage-files-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "empty.bin");
    const storage = createStoragePlugin({
      name: "empty-test",
      protocol: "test",
      get: async () => ({ response: new Response(null) }),
    });

    await writeStorageFile(storage, "test://bucket/empty.bin", filePath);

    expect((await fs.stat(filePath)).size).toBe(0);
  });

  it("removes a partial file when the response stream fails", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "storage-files-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "partial.bin");
    const streamError = new Error("storage stream failed");
    let pulled = false;
    const storage = createStoragePlugin({
      name: "failing-test",
      protocol: "test",
      get: async () => ({
        response: new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!pulled) {
                pulled = true;
                controller.enqueue(new Uint8Array(64 * 1024).fill(1));
                return;
              }
              controller.error(streamError);
            },
          }),
        ),
      }),
    });

    await expect(
      writeStorageFile(storage, "test://bucket/partial.bin", filePath),
    ).rejects.toBe(streamError);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

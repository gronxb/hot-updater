import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import { createMemoryStoragePlugin, storageTestContext } from "./memoryStorage";

const expectCode = async (
  operation: Promise<unknown>,
  code: StoragePluginError["code"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({
    name: "StoragePluginError",
    code,
  } satisfies Partial<StoragePluginError>);
};

describe("Storage v2 malformed input boundaries", () => {
  it("rejects a reversed byte range", async () => {
    // Given
    const plugin = createMemoryStoragePlugin();

    // When
    const operation = plugin.get({
      context: storageTestContext,
      storageUri: "memory://storage/object",
      range: { start: 2, end: 1 },
    });

    // Then
    await expectCode(operation, "invalid-input");
  });

  it("rejects an unsafe byte range", async () => {
    // Given
    const plugin = createMemoryStoragePlugin();

    // When
    const operation = plugin.get({
      context: storageTestContext,
      storageUri: "memory://storage/object",
      range: { start: Number.MAX_SAFE_INTEGER + 1 },
    });

    // Then
    await expectCode(operation, "invalid-input");
  });

  it("rejects a byte body length mismatch", async () => {
    // Given
    const plugin = createMemoryStoragePlugin();

    // When
    const operation = plugin.put({
      context: storageTestContext,
      key: "byte-mismatch",
      body: new Uint8Array([1]),
      contentLength: 2,
    });

    // Then
    await expectCode(operation, "invalid-input");
  });

  it("rejects a stream body length mismatch", async () => {
    // Given
    const plugin = createMemoryStoragePlugin();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    // When
    const operation = plugin.put({
      context: storageTestContext,
      key: "stream-mismatch",
      body,
      contentLength: 2,
    });

    // Then
    await expectCode(operation, "integrity");
  });
});

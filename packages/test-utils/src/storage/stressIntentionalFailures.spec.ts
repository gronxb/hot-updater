import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { expect, it } from "vitest";

import {
  StorageConformanceError,
  storageConformanceAssertions,
} from "./conformanceAssertions";
import { createMemoryStoragePlugin, storageTestContext } from "./memoryStorage";

const sameLengthCorruptingPlugin =
  (): StoragePlugin<StorageOperationContext> => {
    const plugin = createMemoryStoragePlugin();
    return {
      ...plugin,
      async get(input) {
        const result = await plugin.get(input);
        if (result.kind !== "found") {
          return result;
        }
        return {
          ...result,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(result.metadata.contentLength));
              controller.close();
            },
          }),
        };
      },
    };
  };

const legacyLengthOnlyLargeBodyCheck = async (
  plugin: StoragePlugin<StorageOperationContext>,
): Promise<void> => {
  const chunkCount = 64;
  const chunkLength = 32 * 1024;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls === chunkCount) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkLength).fill(pulls % 251));
      pulls += 1;
    },
  });
  const put = await plugin.put({
    context: storageTestContext,
    key: "legacy-length-only",
    body,
    contentLength: chunkCount * chunkLength,
  });
  if (put.kind !== "stored" || pulls !== chunkCount) {
    throw new Error("Legacy put check failed.");
  }
  const result = await plugin.get({
    context: storageTestContext,
    storageUri: put.storageUri,
  });
  if (result.kind !== "found") {
    throw new Error("Legacy get check failed.");
  }
  const bytes = await new Response(result.body).arrayBuffer();
  if (bytes.byteLength !== chunkCount * chunkLength) {
    throw new Error("Legacy length check failed.");
  }
};

it("detects same-length large-stream corruption and duplication", async () => {
  // Given
  const plugin = sameLengthCorruptingPlugin();

  // When
  const operation = storageConformanceAssertions.largeBodyBoundedBackpressure(
    plugin,
    storageTestContext,
  );

  // Then
  await expect(operation).rejects.toMatchObject({
    name: "StorageConformanceError",
    assertion: "large-body-bounded-backpressure",
  } satisfies Partial<StorageConformanceError>);
});

it.runIf(process.env.STORAGE_V2_STRESS_RED === "length-only")(
  "RED exposes that the legacy large-body assertion accepts corrupted bytes",
  async () => {
    // Given
    const plugin = sameLengthCorruptingPlugin();

    // When
    const operation = legacyLengthOnlyLargeBodyCheck(plugin);

    // Then
    await expect(operation).rejects.toBeInstanceOf(StorageConformanceError);
  },
);

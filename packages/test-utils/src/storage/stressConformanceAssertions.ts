import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  createPacedStorageStream,
  failConformance,
  readStorageStream,
  storageBytesEqual,
  verifyStorageChunkSequence,
} from "./conformanceSupport";

const historicalStorageKeys = [
  "updates/bundle-id/bundle.zip",
  "updates/bundle-id/manifest.json",
  "updates/bundle-id/files",
  "updates/bundle-id/files/assets/logo.png",
  "updates/bundle-id/patches/base-bundle-id/index.ios.bundle.bsdiff",
  "updates/assets",
  "updates/assets/sha256/ab/abcdef.png",
] as const;

export const stressConformanceAssertions = {
  async historicalUriRoundTrip<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const writes = await Promise.all(
      historicalStorageKeys.map((key, index) => {
        const body = new Uint8Array([index, 255 - index]);
        return plugin.put({
          context,
          key,
          body,
          contentLength: body.byteLength,
        });
      }),
    );
    const storageUris = writes.map((write) => write.storageUri);
    if (
      writes.some((write) => write.kind !== "stored") ||
      new Set(storageUris).size !== historicalStorageKeys.length ||
      storageUris.some(
        (storageUri) => new URL(storageUri).protocol !== `${plugin.protocol}:`,
      )
    ) {
      failConformance(
        "historical-uri-round-trip",
        "historical keys did not produce distinct provider URIs",
      );
    }

    const reads = await Promise.all(
      storageUris.map((storageUri) => plugin.get({ context, storageUri })),
    );
    for (const [index, read] of reads.entries()) {
      const expected = new Uint8Array([index, 255 - index]);
      if (
        read.kind !== "found" ||
        !storageBytesEqual(await readStorageStream(read.body), expected)
      ) {
        failConformance(
          "historical-uri-round-trip",
          "a historical URI did not retrieve its independently keyed body",
        );
      }
    }
  },

  async concurrentDistinctRequests<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const requests = Array.from(
      { length: 20 },
      (_, index) => new Uint8Array([index, index ^ 0xff]),
    );
    const writes = await Promise.all(
      requests.map((body, index) =>
        plugin.put({
          context,
          key: `conformance/concurrent/${index}`,
          body,
          contentLength: body.byteLength,
          condition: "create-only",
        }),
      ),
    );
    if (writes.some((write) => write.kind !== "stored")) {
      failConformance(
        "concurrent-distinct-requests",
        "a distinct concurrent create-only request was lost",
      );
    }

    const reads = await Promise.all(
      writes.map((write) =>
        plugin.get({ context, storageUri: write.storageUri }),
      ),
    );
    for (const [index, read] of reads.entries()) {
      const expected = requests[index];
      if (
        expected === undefined ||
        read.kind !== "found" ||
        !storageBytesEqual(await readStorageStream(read.body), expected)
      ) {
        failConformance(
          "concurrent-distinct-requests",
          "concurrent request bodies crossed or were duplicated",
        );
      }
    }
  },

  async largeBodyBoundedBackpressure<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const chunkCount = 64;
    const chunkLength = 32 * 1024;
    const byteLength = chunkCount * chunkLength;
    const paced = createPacedStorageStream(chunkCount, chunkLength);
    let settled = false;
    const putPromise = plugin
      .put({
        context,
        key: "conformance/large-chunks",
        body: paced.stream,
        contentLength: byteLength,
      })
      .finally(() => {
        settled = true;
      });

    for (
      let expectedPulls = 1;
      expectedPulls <= chunkCount;
      expectedPulls += 1
    ) {
      await paced.waitForPull(expectedPulls);
      if (settled) {
        failConformance(
          "large-body-bounded-backpressure",
          "put settled before the paced producer completed",
        );
      }
      paced.releaseNext();
    }

    const put = await putPromise;
    const producer = paced.metrics();
    if (
      put.kind !== "stored" ||
      producer.pulls !== chunkCount ||
      producer.backpressureEvents !== chunkCount ||
      producer.maxBufferedBytes >= byteLength
    ) {
      failConformance(
        "large-body-bounded-backpressure",
        "producer backpressure or maximum buffer bound was not observable",
      );
    }

    const result = await plugin.get({ context, storageUri: put.storageUri });
    if (result.kind === "not-found") {
      failConformance(
        "large-body-bounded-backpressure",
        "large streamed object was not found",
      );
      return;
    }
    const verified = await verifyStorageChunkSequence(result.body, chunkLength);
    if (
      result.metadata.contentLength !== byteLength ||
      verified.byteLength !== byteLength ||
      verified.chunkCount !== chunkCount ||
      verified.duplicateChunks !== 0
    ) {
      failConformance(
        "large-body-bounded-backpressure",
        "large stream length or chunk uniqueness was incorrect",
      );
    }
  },
} as const;

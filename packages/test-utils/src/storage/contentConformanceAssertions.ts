import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  failConformance,
  putStorageFixture,
  readStorageStream,
  storageBytesEqual,
} from "./conformanceSupport";

export const contentConformanceAssertions = {
  async byteRoundTrip<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const expected = new Uint8Array([0, 1, 127, 255]);
    const storageUri = await putStorageFixture({
      plugin,
      context,
      key: "conformance/bytes",
      body: expected,
      assertion: "byte-round-trip",
    });
    const result = await plugin.get({ context, storageUri });
    if (
      result.kind !== "found" ||
      !storageBytesEqual(await readStorageStream(result.body), expected)
    ) {
      failConformance("byte-round-trip", "stored bytes did not round-trip");
    }
  },

  async streamRoundTrip<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const expected = new Uint8Array([9, 8, 7, 6]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected.slice(0, 2));
        controller.enqueue(expected.slice(2));
        controller.close();
      },
    });
    const put = await plugin.put({
      context,
      key: "conformance/stream",
      body,
      contentLength: expected.byteLength,
    });
    if (put.kind !== "stored") {
      failConformance("stream-round-trip", "stream body was not stored");
    }
    const result = await plugin.get({ context, storageUri: put.storageUri });
    if (
      result.kind !== "found" ||
      !storageBytesEqual(await readStorageStream(result.body), expected)
    ) {
      failConformance("stream-round-trip", "stored stream did not round-trip");
    }
  },

  async atomicCreateOnly<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const outcomes = await Promise.all(
      [new Uint8Array([1]), new Uint8Array([2])].map((body) =>
        plugin.put({
          context,
          key: "conformance/atomic",
          body,
          contentLength: body.byteLength,
          condition: "create-only",
        }),
      ),
    );
    const stored = outcomes.filter((result) => result.kind === "stored").length;
    const existing = outcomes.filter(
      (result) => result.kind === "already-exists",
    ).length;
    if (stored !== 1 || existing !== 1) {
      failConformance(
        "atomic-create-only",
        "concurrent create-only writes did not produce one winner",
      );
    }
  },

  async inclusiveRangeAndMetadata<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const body = new Uint8Array([10, 20, 30, 40, 50]);
    const put = await plugin.put({
      context,
      key: "conformance/range",
      body,
      contentLength: body.byteLength,
      contentType: "application/octet-stream",
      metadata: { release: "stable" },
    });
    if (put.kind !== "stored") {
      failConformance("inclusive-range-and-metadata", "fixture was not stored");
    }
    const result = await plugin.get({
      context,
      storageUri: put.storageUri,
      range: { start: 1, end: 3 },
    });
    if (
      result.kind !== "found" ||
      !storageBytesEqual(
        await readStorageStream(result.body),
        new Uint8Array([20, 30, 40]),
      ) ||
      result.range?.start !== 1 ||
      result.range.end !== 3 ||
      result.range.totalLength !== 5 ||
      result.metadata.contentLength !== 5 ||
      result.metadata.contentType !== "application/octet-stream" ||
      result.metadata.custom?.release !== "stable"
    ) {
      failConformance(
        "inclusive-range-and-metadata",
        "inclusive range bytes or metadata were incorrect",
      );
    }
  },
} as const;

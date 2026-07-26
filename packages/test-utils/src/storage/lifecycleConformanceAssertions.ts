import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  expectStorageErrorCode,
  failConformance,
  putStorageFixture,
} from "./conformanceSupport";

export const lifecycleConformanceAssertions = {
  async headAndNotFound<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const storageUri = await putStorageFixture({
      plugin,
      context,
      key: "conformance/head",
      body: new Uint8Array([4, 5]),
      assertion: "head-and-not-found",
    });
    const found = await plugin.head({ context, storageUri });
    await plugin.delete({ context, storageUri });
    const missing = await plugin.head({ context, storageUri });
    if (
      found.kind !== "found" ||
      found.metadata.contentLength !== 2 ||
      missing.kind !== "not-found"
    ) {
      failConformance(
        "head-and-not-found",
        "head did not distinguish found and missing",
      );
    }
  },

  async exactIdempotentDelete<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const target = await putStorageFixture({
      plugin,
      context,
      key: "conformance/delete/item",
      body: new Uint8Array([1]),
      assertion: "exact-idempotent-delete",
    });
    const sibling = await putStorageFixture({
      plugin,
      context,
      key: "conformance/delete/item-sibling",
      body: new Uint8Array([2]),
      assertion: "exact-idempotent-delete",
    });
    const first = await plugin.delete({ context, storageUri: target });
    const second = await plugin.delete({ context, storageUri: target });
    const siblingHead = await plugin.head({ context, storageUri: sibling });
    if (
      first.kind !== "deleted" ||
      second.kind !== "not-found" ||
      siblingHead.kind !== "found"
    ) {
      failConformance(
        "exact-idempotent-delete",
        "delete was not exact and idempotent",
      );
    }
  },

  async cancellationCancelsInputStream<
    TContext extends StorageOperationContext,
  >(plugin: StoragePlugin<TContext>, context: TContext): Promise<void> {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expectStorageErrorCode(
      plugin.put({
        context,
        key: "conformance/cancel",
        body,
        contentLength: 1,
        signal: controller.signal,
      }),
      "aborted",
      "cancellation-cancels-input-stream",
    );
    if (!cancelled) {
      failConformance(
        "cancellation-cancels-input-stream",
        "aborting put did not cancel its input stream",
      );
    }
  },

  async optionalCapabilitiesOmitted<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    _context: TContext,
  ): Promise<void> {
    if ("issueDownload" in plugin || "list" in plugin) {
      failConformance(
        "optional-capabilities-omitted",
        "unsupported optional capability was present",
      );
    }
  },

  async uriValidation<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    context: TContext,
  ): Promise<void> {
    const wrongProtocol =
      plugin.protocol === "conformance-invalid"
        ? "other"
        : "conformance-invalid";
    await expectStorageErrorCode(
      plugin.get({
        context,
        storageUri: `${wrongProtocol}://storage.invalid/object`,
      }),
      "invalid-uri",
      "uri-validation",
    );
    await expectStorageErrorCode(
      plugin.head({ context, storageUri: "not a uri" }),
      "invalid-uri",
      "uri-validation",
    );
  },

  async unmountIsIdempotent<TContext extends StorageOperationContext>(
    plugin: StoragePlugin<TContext>,
    _context: TContext,
  ): Promise<void> {
    const onUnmount = plugin.onUnmount;
    if (onUnmount !== undefined) {
      const first = onUnmount();
      const second = onUnmount();
      if (first !== second) {
        failConformance("unmount-is-idempotent", "cleanup was not reused");
      }
      await first;
      return;
    }
    failConformance("unmount-is-idempotent", "onUnmount was omitted");
  },
} as const;

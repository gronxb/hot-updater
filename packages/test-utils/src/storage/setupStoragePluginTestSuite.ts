import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import { it } from "vitest";

import { storageConformanceAssertions } from "./conformanceAssertions";
import {
  setupStoragePluginTestRunner,
  type StoragePluginTestLifecycle,
} from "./storagePluginTestRunner";

export type StoragePluginTestSuiteOptions<
  TContext extends StorageOperationContext,
> = StoragePluginTestLifecycle<TContext>;

export const setupStoragePluginTestSuite = <
  TContext extends StorageOperationContext,
>(
  options: StoragePluginTestSuiteOptions<TContext>,
): void => {
  setupStoragePluginTestRunner(options, ({ context, getPlugin }) => {
    it("byte-round-trip", async () => {
      await storageConformanceAssertions.byteRoundTrip(getPlugin(), context);
    });
    it("stream-round-trip", async () => {
      await storageConformanceAssertions.streamRoundTrip(getPlugin(), context);
    });
    it("historical-uri-round-trip", async () => {
      await storageConformanceAssertions.historicalUriRoundTrip(
        getPlugin(),
        context,
      );
    });
    it("concurrent-distinct-requests", async () => {
      await storageConformanceAssertions.concurrentDistinctRequests(
        getPlugin(),
        context,
      );
    });
    it("large-body-bounded-backpressure", async () => {
      await storageConformanceAssertions.largeBodyBoundedBackpressure(
        getPlugin(),
        context,
      );
    });
    it("atomic-create-only", async () => {
      await storageConformanceAssertions.atomicCreateOnly(getPlugin(), context);
    });
    it("inclusive-range-and-metadata", async () => {
      await storageConformanceAssertions.inclusiveRangeAndMetadata(
        getPlugin(),
        context,
      );
    });
    it("head-and-not-found", async () => {
      await storageConformanceAssertions.headAndNotFound(getPlugin(), context);
    });
    it("exact-idempotent-delete", async () => {
      await storageConformanceAssertions.exactIdempotentDelete(
        getPlugin(),
        context,
      );
    });
    it("cancellation-cancels-input-stream", async () => {
      await storageConformanceAssertions.cancellationCancelsInputStream(
        getPlugin(),
        context,
      );
    });
    it("optional-capabilities-omitted", async () => {
      await storageConformanceAssertions.optionalCapabilitiesOmitted(
        getPlugin(),
        context,
      );
    });
    it("uri-validation", async () => {
      await storageConformanceAssertions.uriValidation(getPlugin(), context);
    });
    it("unmount-is-idempotent", async () => {
      await storageConformanceAssertions.unmountIsIdempotent(
        getPlugin(),
        context,
      );
    });
  });
};

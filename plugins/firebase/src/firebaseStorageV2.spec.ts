import type { StoragePlugin } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { storageConformanceAssertions } from "@hot-updater/test-utils/storage";
import { beforeEach, describe, it } from "vitest";

import { createFirebaseStorage } from "./storage/firebaseStorage";
import { createFirebaseStorageFake } from "./storage/firebaseStorageTestFake";
import { createFunctionsStorageContext } from "./storage/functionsContext";

const nodeContext = createNodeStorageContext({ environment: {} });
const functionsContext = createFunctionsStorageContext({
  environment: {},
  bindings: {},
});

describe.each([
  ["node", nodeContext],
  ["functions", functionsContext],
] as const)(
  "Firebase Storage v2 %s supported conformance",
  (target, context) => {
    let plugin: StoragePlugin;

    beforeEach(() => {
      const fake = createFirebaseStorageFake();
      plugin = createFirebaseStorage(
        { storageBucket: "release-bucket", basePath: "updates" },
        target,
        fake.factory,
      );
    });

    it("passes byte round trip", async () => {
      await storageConformanceAssertions.byteRoundTrip(plugin, context);
    });

    it("passes stream round trip", async () => {
      await storageConformanceAssertions.streamRoundTrip(plugin, context);
    });

    it("uses the SDK atomic create-only precondition", async () => {
      await storageConformanceAssertions.atomicCreateOnly(plugin, context);
    });

    it("passes inclusive range and metadata", async () => {
      await storageConformanceAssertions.inclusiveRangeAndMetadata(
        plugin,
        context,
      );
    });

    it("passes head and not-found", async () => {
      await storageConformanceAssertions.headAndNotFound(plugin, context);
    });

    it("passes exact idempotent delete", async () => {
      await storageConformanceAssertions.exactIdempotentDelete(plugin, context);
    });

    it("cancels a pre-aborted input stream", async () => {
      await storageConformanceAssertions.cancellationCancelsInputStream(
        plugin,
        context,
      );
    });

    it("validates storage URIs", async () => {
      await storageConformanceAssertions.uriValidation(plugin, context);
    });

    it("closes cached resources idempotently", async () => {
      await storageConformanceAssertions.unmountIsIdempotent(plugin, context);
    });
  },
);

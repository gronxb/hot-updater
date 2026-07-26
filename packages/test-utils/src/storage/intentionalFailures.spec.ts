import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import {
  StorageConformanceError,
  storageConformanceAssertions,
} from "./conformanceAssertions";
import { createMemoryStoragePlugin, storageTestContext } from "./memoryStorage";

type TestPlugin = StoragePlugin<StorageOperationContext>;

const nonAtomicCreatePlugin = (): TestPlugin => {
  const plugin = createMemoryStoragePlugin();
  return {
    ...plugin,
    async put(input) {
      const { condition: _condition, ...unconditionalInput } = input;
      return plugin.put(unconditionalInput);
    },
  };
};

const prefixDeletePlugin = (): TestPlugin => {
  const plugin = createMemoryStoragePlugin();
  return {
    ...plugin,
    async delete(input) {
      const result = await plugin.delete(input);
      await plugin.delete({
        ...input,
        storageUri: `${input.storageUri}-sibling`,
      });
      return result;
    },
  };
};

const wrongRangePlugin = (): TestPlugin => {
  const plugin = createMemoryStoragePlugin();
  return {
    ...plugin,
    async get(input) {
      const { range: _range, ...wholeObjectInput } = input;
      return plugin.get(wholeObjectInput);
    },
  };
};

const uncancelledStreamPlugin = (): TestPlugin => {
  const plugin = createMemoryStoragePlugin();
  return {
    ...plugin,
    async put(input) {
      if (input.signal?.aborted === true) {
        return {
          kind: "stored",
          storageUri: "memory://storage/conformance/cancel",
        };
      }
      return plugin.put(input);
    },
  };
};

const doubleCleanupPlugin = (): TestPlugin => {
  const plugin = createMemoryStoragePlugin();
  return {
    ...plugin,
    async onUnmount() {
      await plugin.onUnmount?.();
    },
  };
};

const expectNamedFailure = async (
  operation: Promise<void>,
  assertion: StorageConformanceError["assertion"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({
    name: "StorageConformanceError",
    assertion,
  });
};

describe("deliberately broken Storage v2 adapters", () => {
  it("detects non-atomic create-only writes", async () => {
    await expectNamedFailure(
      storageConformanceAssertions.atomicCreateOnly(
        nonAtomicCreatePlugin(),
        storageTestContext,
      ),
      "atomic-create-only",
    );
  });

  it("detects prefix deletion", async () => {
    await expectNamedFailure(
      storageConformanceAssertions.exactIdempotentDelete(
        prefixDeletePlugin(),
        storageTestContext,
      ),
      "exact-idempotent-delete",
    );
  });

  it("detects a non-inclusive range implementation", async () => {
    await expectNamedFailure(
      storageConformanceAssertions.inclusiveRangeAndMetadata(
        wrongRangePlugin(),
        storageTestContext,
      ),
      "inclusive-range-and-metadata",
    );
  });

  it("detects an uncancelled input stream", async () => {
    await expectNamedFailure(
      storageConformanceAssertions.cancellationCancelsInputStream(
        uncancelledStreamPlugin(),
        storageTestContext,
      ),
      "cancellation-cancels-input-stream",
    );
  });

  it("detects repeated cleanup", async () => {
    await expectNamedFailure(
      storageConformanceAssertions.unmountIsIdempotent(
        doubleCleanupPlugin(),
        storageTestContext,
      ),
      "unmount-is-idempotent",
    );
  });
});

const redDefect = process.env.STORAGE_V2_RED_DEFECT;

it.runIf(redDefect === "non-atomic-create")(
  "RED exposes non-atomic create-only writes",
  async () => {
    await storageConformanceAssertions.atomicCreateOnly(
      nonAtomicCreatePlugin(),
      storageTestContext,
    );
  },
);

it.runIf(redDefect === "prefix-delete")(
  "RED exposes prefix deletion",
  async () => {
    await storageConformanceAssertions.exactIdempotentDelete(
      prefixDeletePlugin(),
      storageTestContext,
    );
  },
);

it.runIf(redDefect === "wrong-range")(
  "RED exposes wrong inclusive range handling",
  async () => {
    await storageConformanceAssertions.inclusiveRangeAndMetadata(
      wrongRangePlugin(),
      storageTestContext,
    );
  },
);

it.runIf(redDefect === "uncancelled-stream")(
  "RED exposes an uncancelled input stream",
  async () => {
    await storageConformanceAssertions.cancellationCancelsInputStream(
      uncancelledStreamPlugin(),
      storageTestContext,
    );
  },
);

it.runIf(redDefect === "double-cleanup")(
  "RED exposes repeated cleanup",
  async () => {
    await storageConformanceAssertions.unmountIsIdempotent(
      doubleCleanupPlugin(),
      storageTestContext,
    );
  },
);

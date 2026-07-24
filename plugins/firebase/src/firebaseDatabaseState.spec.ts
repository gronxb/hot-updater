import { describe, expect, it, vi } from "vitest";

import { createFirebaseTransactionDatabaseState } from "./firebaseDatabaseState";

describe("createFirebaseTransactionDatabaseState", () => {
  it("loads bundle events only when a transaction accesses them", async () => {
    // Given
    const loadBundleEvents = vi.fn(async () => {});
    const database = createFirebaseTransactionDatabaseState(
      {
        bundles: new Map(),
        bundlePatches: new Map(),
        bundleEvents: new Map(),
      },
      loadBundleEvents,
    );

    // When
    await database.count({ model: "bundles" });
    await database.findMany({
      model: "bundle_patches",
      limit: 10,
      offset: 0,
    });

    // Then
    expect(loadBundleEvents).not.toHaveBeenCalled();

    // When
    await database.count({ model: "bundle_events" });
    await database.findMany({
      model: "bundle_events",
      limit: 10,
      offset: 0,
    });

    // Then
    expect(loadBundleEvents).toHaveBeenCalledOnce();
  });
});

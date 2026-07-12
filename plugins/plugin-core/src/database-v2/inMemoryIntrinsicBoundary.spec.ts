import { describe, expect, it } from "vitest";

import type { BundleChangeSetV2 } from "./bundles";
import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";

const requireMapSetDescriptor = (): PropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, "set");
  if (descriptor === undefined) {
    throw new TypeError("Map.prototype.set descriptor is unavailable");
  }
  return descriptor;
};

const suppressMapWritesDuringInspection = (
  changeSet: BundleChangeSetV2,
): BundleChangeSetV2 =>
  new Proxy(changeSet, {
    getPrototypeOf: (target) => {
      Reflect.set(Map.prototype, "set", function suppressMapSet<
        K,
        V,
      >(this: Map<K, V>): Map<K, V> {
        return this;
      });
      return Reflect.getPrototypeOf(target);
    },
  });

describe("in-memory database-v2 intrinsic boundary", () => {
  it("persists and replays when input inspection mutates Map.prototype.set", async () => {
    // Given a valid change set whose inspection suppresses later live Map writes
    const connector = createInMemoryDatabaseConnectorV2();
    const connection = await connector.connect();
    const session = await connection.openSession(IN_MEMORY_TEST_SCOPE);
    const changeSet = createInMemoryPutChangeSet(
      "10000000-0000-4000-8000-000000000130",
      [createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first)],
    );
    const originalMapSet = requireMapSetDescriptor();
    let firstReceipt;

    // When the proxy mutates the live intrinsic during canonical inspection
    try {
      firstReceipt = await session.applyChangeSet(
        suppressMapWritesDuringInspection(changeSet),
      );
    } finally {
      Object.defineProperty(Map.prototype, "set", originalMapSet);
    }

    // Then the committed row exists and an identical retry is a replay
    expect(firstReceipt.outcome).toBe("committed");
    await expect(
      session.bundles.get(IN_MEMORY_TEST_IDS.first),
    ).resolves.toMatchObject({ value: { id: IN_MEMORY_TEST_IDS.first } });
    await expect(session.applyChangeSet(changeSet)).resolves.toMatchObject({
      outcome: "replayed",
    });
    await connection.close();
  });
});

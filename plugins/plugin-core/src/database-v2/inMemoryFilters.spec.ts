import { describe, expect, it } from "vitest";

import { DatabaseConnectorErrorV2 } from "./errors";
import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";

describe("in-memory database-v2 query filters", () => {
  it("applies the complete bundle filter vocabulary before pagination", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    const first = createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first, "alpha");
    first.targetAppVersion = null;
    first.fingerprintHash = "fingerprint-a";
    const second = createInMemoryTestBundle(IN_MEMORY_TEST_IDS.second, "beta");
    second.platform = "android";
    second.enabled = false;
    second.targetAppVersion = "2.0.0";
    const third = createInMemoryTestBundle(IN_MEMORY_TEST_IDS.third, "alpha");
    third.targetAppVersion = "3.0.0";
    await givenSession.applyChangeSet(
      createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000112", [
        first,
        second,
        third,
      ]),
    );

    const whenChannel = await givenSession.bundles.page({
      limit: 10,
      where: { channel: "alpha" },
    });
    const whenPlatform = await givenSession.bundles.page({
      limit: 10,
      where: { platform: "android", enabled: false },
    });
    const whenIdRange = await givenSession.bundles.page({
      limit: 10,
      where: {
        id: {
          gt: IN_MEMORY_TEST_IDS.first,
          gte: IN_MEMORY_TEST_IDS.second,
          lt: IN_MEMORY_TEST_IDS.fourth,
          lte: IN_MEMORY_TEST_IDS.third,
          in: [IN_MEMORY_TEST_IDS.second, IN_MEMORY_TEST_IDS.third],
        },
      },
    });
    const whenNullable = await givenSession.bundles.page({
      limit: 10,
      where: {
        targetAppVersion: null,
        fingerprintHash: "fingerprint-a",
      },
    });
    const whenNonNull = await givenSession.bundles.page({
      limit: 10,
      where: {
        targetAppVersionNotNull: true,
        targetAppVersionIn: ["2.0.0", "3.0.0"],
      },
    });

    expect(whenChannel.data.map((row) => row.value.id).toSorted()).toEqual([
      IN_MEMORY_TEST_IDS.first,
      IN_MEMORY_TEST_IDS.third,
    ]);
    expect(whenPlatform.data.map((row) => row.value.id)).toEqual([
      IN_MEMORY_TEST_IDS.second,
    ]);
    expect(whenIdRange.data.map((row) => row.value.id).toSorted()).toEqual([
      IN_MEMORY_TEST_IDS.second,
      IN_MEMORY_TEST_IDS.third,
    ]);
    expect(whenNullable.data.map((row) => row.value.id)).toEqual([
      IN_MEMORY_TEST_IDS.first,
    ]);
    expect(whenNonNull.data.map((row) => row.value.id).toSorted()).toEqual([
      IN_MEMORY_TEST_IDS.second,
      IN_MEMORY_TEST_IDS.third,
    ]);
    expect(await givenSession.bundles.channels()).toEqual(["alpha", "beta"]);
    await givenConnection.close();
  });

  it("rejects malformed page shapes with one indistinguishable code", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    const malformedQueries: readonly object[] = [
      {},
      { limit: 0 },
      { limit: 1001 },
      { limit: 1, cursor: { after: "a", before: "b" } },
      { limit: 1, orderBy: { field: "createdAt", direction: "asc" } },
      { limit: 1, where: { platform: "web" } },
      { limit: 1, extra: true },
    ];

    const whenErrors = await Promise.all(
      malformedQueries.map(async (query) => {
        try {
          await Reflect.apply(givenSession.bundles.page, givenSession.bundles, [
            query,
          ]);
          return null;
        } catch (error) {
          if (error instanceof Error) return error;
          throw error;
        }
      }),
    );

    expect(
      whenErrors.every(
        (error) =>
          error instanceof DatabaseConnectorErrorV2 &&
          error.code === "INVALID_CURSOR",
      ),
    ).toBe(true);
    await givenConnection.close();
  });
});

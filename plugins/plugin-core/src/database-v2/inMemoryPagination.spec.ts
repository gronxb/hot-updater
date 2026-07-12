import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryDeleteChangeSet,
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  expectInvalidInMemoryCursor,
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";

describe("in-memory database-v2 pagination", () => {
  it("implements exact after and before pagination flags", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    await givenSession.applyChangeSet(
      createInMemoryPutChangeSet(
        "10000000-0000-4000-8000-000000000102",
        Object.values(IN_MEMORY_TEST_IDS).map((id) =>
          createInMemoryTestBundle(id),
        ),
      ),
    );

    const whenFirst = await givenSession.bundles.page({ limit: 2 });
    const whenSecond = await givenSession.bundles.page({
      limit: 2,
      cursor: { after: whenFirst.pagination.nextCursor ?? "missing" },
    });
    const whenBack = await givenSession.bundles.page({
      limit: 2,
      cursor: { before: whenSecond.pagination.previousCursor ?? "missing" },
    });

    expect(whenFirst.data.map((row) => row.value.id)).toEqual([
      IN_MEMORY_TEST_IDS.fourth,
      IN_MEMORY_TEST_IDS.third,
    ]);
    expect(whenFirst.pagination).toMatchObject({
      total: 4,
      hasPreviousPage: false,
      hasNextPage: true,
      previousCursor: null,
    });
    expect(whenSecond.data.map((row) => row.value.id)).toEqual([
      IN_MEMORY_TEST_IDS.second,
      IN_MEMORY_TEST_IDS.first,
    ]);
    expect(whenSecond.pagination).toMatchObject({
      total: 4,
      hasPreviousPage: true,
      hasNextPage: false,
      nextCursor: null,
    });
    expect(whenBack.data.map((row) => row.value.id)).toEqual([
      IN_MEMORY_TEST_IDS.fourth,
      IN_MEMORY_TEST_IDS.third,
    ]);
    await givenConnection.close();
  });

  it("invalidates a cursor when its anchor is deleted", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    await givenSession.applyChangeSet(
      createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000103", [
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first),
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.second),
      ]),
    );
    const givenPage = await givenSession.bundles.page({
      limit: 1,
      orderBy: { field: "id", direction: "asc" },
    });
    const givenAnchor = await givenSession.bundles.get(
      IN_MEMORY_TEST_IDS.first,
    );
    await givenSession.applyChangeSet(
      createInMemoryDeleteChangeSet(
        "10000000-0000-4000-8000-000000000104",
        IN_MEMORY_TEST_IDS.first,
        givenAnchor?.revision ?? "missing",
      ),
    );

    const whenUsingDeletedAnchor = () =>
      givenSession.bundles.page({
        limit: 1,
        orderBy: { field: "id", direction: "asc" },
        cursor: { after: givenPage.pagination.nextCursor ?? "missing" },
      });

    await expectInvalidInMemoryCursor(whenUsingDeletedAnchor);
    await givenConnection.close();
  });

  it("invalidates live-anchor after and before cursors that become empty", async () => {
    const afterConnector = createInMemoryDatabaseConnectorV2();
    const afterConnection = await afterConnector.connect();
    const afterSession =
      await afterConnection.openSession(IN_MEMORY_TEST_SCOPE);
    await afterSession.applyChangeSet(
      createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000105", [
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first),
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.second),
      ]),
    );
    const afterFirst = await afterSession.bundles.page({
      limit: 1,
      orderBy: { field: "id", direction: "asc" },
    });
    const second = await afterSession.bundles.get(IN_MEMORY_TEST_IDS.second);
    await afterSession.applyChangeSet(
      createInMemoryDeleteChangeSet(
        "10000000-0000-4000-8000-000000000106",
        IN_MEMORY_TEST_IDS.second,
        second?.revision ?? "missing",
      ),
    );
    await expectInvalidInMemoryCursor(() =>
      afterSession.bundles.page({
        limit: 1,
        orderBy: { field: "id", direction: "asc" },
        cursor: { after: afterFirst.pagination.nextCursor ?? "missing" },
      }),
    );

    const beforeConnector = createInMemoryDatabaseConnectorV2();
    const beforeConnection = await beforeConnector.connect();
    const beforeSession =
      await beforeConnection.openSession(IN_MEMORY_TEST_SCOPE);
    await beforeSession.applyChangeSet(
      createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000107", [
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first),
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.second),
      ]),
    );
    const beforeFirst = await beforeSession.bundles.page({
      limit: 1,
      orderBy: { field: "id", direction: "asc" },
    });
    const beforeSecond = await beforeSession.bundles.page({
      limit: 1,
      orderBy: { field: "id", direction: "asc" },
      cursor: { after: beforeFirst.pagination.nextCursor ?? "missing" },
    });
    const first = await beforeSession.bundles.get(IN_MEMORY_TEST_IDS.first);
    await beforeSession.applyChangeSet(
      createInMemoryDeleteChangeSet(
        "10000000-0000-4000-8000-000000000108",
        IN_MEMORY_TEST_IDS.first,
        first?.revision ?? "missing",
      ),
    );
    await expectInvalidInMemoryCursor(() =>
      beforeSession.bundles.page({
        limit: 1,
        orderBy: { field: "id", direction: "asc" },
        cursor: {
          before: beforeSecond.pagination.previousCursor ?? "missing",
        },
      }),
    );
    await Promise.all([afterConnection.close(), beforeConnection.close()]);
  });
});

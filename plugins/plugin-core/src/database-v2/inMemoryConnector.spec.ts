import { setupDatabaseConnectorV2TestSuite } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as databaseV2 from "./index";
import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";
import { inMemoryConnectorV2TestHarness } from "./inMemoryConnector.testHarness";

setupDatabaseConnectorV2TestSuite(inMemoryConnectorV2TestHarness);

describe("createInMemoryDatabaseConnectorV2", () => {
  it("publishes the in-memory connector factory", () => {
    const givenModule = databaseV2;
    const whenFactory = Reflect.get(
      givenModule,
      "createInMemoryDatabaseConnectorV2",
    );
    expect(typeof whenFactory).toBe("function");
  });

  it("keeps the fixed manifest and rows for the connector lifetime", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    await givenSession.applyChangeSet(
      createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000101", [
        createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first),
      ]),
    );

    await givenConnection.close();
    const whenReconnected = await givenConnector.connect();
    const whenSession = await whenReconnected.openSession(IN_MEMORY_TEST_SCOPE);

    const thenStored = await whenSession.bundles.get(IN_MEMORY_TEST_IDS.first);
    expect(thenStored?.value.id).toBe(IN_MEMORY_TEST_IDS.first);
    expect(givenConnector.manifest).toBe(
      databaseV2.IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2,
    );
    await whenReconnected.close();
  });

  it("serializes conflicting commits across independent connections", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenFirstConnection = await givenConnector.connect();
    const givenSecondConnection = await givenConnector.connect();
    const givenFirst =
      await givenFirstConnection.openSession(IN_MEMORY_TEST_SCOPE);
    const givenSecond =
      await givenSecondConnection.openSession(IN_MEMORY_TEST_SCOPE);

    const whenReceipts = await Promise.all([
      givenFirst.applyChangeSet(
        createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000110", [
          createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first, "first"),
        ]),
      ),
      givenSecond.applyChangeSet(
        createInMemoryPutChangeSet("10000000-0000-4000-8000-000000000111", [
          createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first, "second"),
        ]),
      ),
    ]);

    const thenOutcomes = whenReceipts
      .map((receipt) => receipt.outcome)
      .toSorted();
    expect(thenOutcomes).toEqual(["committed", "rejected"]);
    expect((await givenFirst.bundles.page({ limit: 10 })).data).toHaveLength(1);
    await Promise.all([
      givenFirstConnection.close(),
      givenSecondConnection.close(),
    ]);
  });
});

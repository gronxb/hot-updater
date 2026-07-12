import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";

describe("in-memory database-v2 value isolation", () => {
  it("isolates stored rows from caller input and returned value mutation", async () => {
    const givenConnector = createInMemoryDatabaseConnectorV2();
    const givenConnection = await givenConnector.connect();
    const givenSession =
      await givenConnection.openSession(IN_MEMORY_TEST_SCOPE);
    const givenBundle = createInMemoryTestBundle(IN_MEMORY_TEST_IDS.first);
    const givenChangeSet = createInMemoryPutChangeSet(
      "10000000-0000-4000-8000-000000000109",
      [givenBundle],
    );

    const whenCommitting = givenSession.applyChangeSet(givenChangeSet);
    givenBundle.channel = "mutated-input";
    await whenCommitting;
    const whenRead = await givenSession.bundles.get(IN_MEMORY_TEST_IDS.first);
    if (whenRead !== null) whenRead.value.channel = "mutated-output";

    const thenReadAgain = await givenSession.bundles.get(
      IN_MEMORY_TEST_IDS.first,
    );
    expect(thenReadAgain?.value.channel).toBe("production");
    expect(thenReadAgain?.value.metadata?.app_version).toBe("1.0.0");
    await givenConnection.close();
  });
});

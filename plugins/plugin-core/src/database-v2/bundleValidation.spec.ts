import { describe, expect, it } from "vitest";

import { hostileBundleCases } from "./bundleValidation.hostileTestCases";
import { malformedBundleCases } from "./bundleValidation.testCases";
import {
  createCompleteBundle,
  createPutChangeSet,
} from "./bundleValidation.testFixtures";
import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  IN_MEMORY_TEST_IDS,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";
import { createRuntimeScope } from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

const applyUntypedChangeSet = (
  session: object,
  changeSet: unknown,
): Promise<unknown> =>
  Reflect.apply(Reflect.get(session, "applyChangeSet"), session, [changeSet]);

describe("database-v2 Bundle boundary", () => {
  const createSubject = setupRuntimeTestHarness();

  it("accepts every supported Bundle field", async () => {
    // Given a complete value matching the public Bundle contract
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());

    // When the value crosses the runtime boundary
    await applyUntypedChangeSet(
      session,
      createPutChangeSet(createCompleteBundle()),
    );

    // Then the parsed value reaches the backend unchanged
    expect(backend.commitAttempts).toBe(1);
    expect(backend.observedCommits[0]?.changeSet.changes[0]).toMatchObject({
      type: "put",
      value: createCompleteBundle(),
    });
  });

  it("rejects an id-only put before it becomes durable", async () => {
    // Given an untyped put whose value omits the Bundle contract
    const connector = createInMemoryDatabaseConnectorV2();
    const connection = await connector.connect();
    const session = await connection.openSession(IN_MEMORY_TEST_SCOPE);
    const changeSet = {
      id: "10000000-0000-4000-8000-000000000190",
      changes: [
        {
          type: "put",
          value: { id: IN_MEMORY_TEST_IDS.first },
          precondition: { state: "absent" },
        },
      ],
    };

    // When the malformed value crosses the public runtime boundary
    await expect(
      applyUntypedChangeSet(session, changeSet),
    ).rejects.toMatchObject({ code: "INVALID_CHANGE_SET" });

    // Then no malformed row or non-string channel becomes durable
    await expect(
      session.bundles.get(IN_MEMORY_TEST_IDS.first),
    ).resolves.toBeNull();
    await expect(session.bundles.channels()).resolves.toEqual([]);
    await connection.close();
  });

  for (const malformed of [
    ...malformedBundleCases(),
    ...hostileBundleCases(),
  ]) {
    it(`rejects ${malformed.label} before backend I/O`, async () => {
      // Given one malformed Bundle field or hostile descriptor shape
      const { backend, connection } =
        createSubject<MutableScopeFixture["context"]>();
      const session = await connection.openSession(createRuntimeScope());
      let getterCalls = 0;
      const bundle = malformed.create(() => {
        getterCalls += 1;
      });

      // When the malformed value crosses the runtime boundary
      await expect(
        applyUntypedChangeSet(session, createPutChangeSet(bundle)),
      ).rejects.toMatchObject({ code: "INVALID_CHANGE_SET" });

      // Then validation executes no getter and performs no backend operation
      expect(getterCalls).toBe(0);
      expect(backend.commitAttempts).toBe(0);
      expect(backend.readAttempts).toBe(0);
      expect(backend.observedCommits).toEqual([]);
      expect(backend.rows.size).toBe(0);
      expect(backend.receipts.size).toBe(0);
    });
  }
});

import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseConnectorV2 } from "./inMemoryConnector";
import {
  createInMemoryDeleteChangeSet,
  createInMemoryPutChangeSet,
  createInMemoryTestBundle,
  IN_MEMORY_TEST_SCOPE,
} from "./inMemoryConnector.testFixtures";

describe("database-v2 special bundle IDs", () => {
  it("preserves own revision keys through commit, replay, collision, and delete", async () => {
    // Given bundle IDs that collide with ordinary object prototype names
    const ids = ["__proto__", "constructor", "prototype"] as const;
    const connector = createInMemoryDatabaseConnectorV2();
    const connection = await connector.connect();
    const session = await connection.openSession(IN_MEMORY_TEST_SCOPE);
    const put = createInMemoryPutChangeSet(
      "10000000-0000-4000-8000-000000000301",
      ids.map((id) => createInMemoryTestBundle(id)),
    );

    // When values are committed, replayed, collided, and deleted
    const committed = await session.applyChangeSet(put);
    const replayed = await session.applyChangeSet(put);
    const collision = await session.applyChangeSet({
      ...put,
      changes: [
        {
          type: "put",
          value: createInMemoryTestBundle("other"),
          precondition: { state: "absent" },
        },
      ],
    });

    // Then all revision keys are own data properties and collision is atomic
    expect(committed.outcome).toBe("committed");
    expect(replayed.outcome).toBe("replayed");
    if (committed.outcome === "committed") {
      for (const id of ids) {
        expect(Object.hasOwn(committed.revisions, id)).toBe(true);
      }
    }
    if (replayed.outcome === "replayed") {
      for (const id of ids) {
        expect(Object.hasOwn(replayed.revisions, id)).toBe(true);
      }
    }
    expect(collision).toMatchObject({
      outcome: "rejected",
      reason: "conflict",
    });
    expect(await session.bundles.get("other")).toBeNull();

    for (const [index, id] of ids.entries()) {
      const row = await session.bundles.get(id);
      expect(row).not.toBeNull();
      if (row !== null) {
        const deleted = await session.applyChangeSet(
          createInMemoryDeleteChangeSet(
            `10000000-0000-4000-8000-00000000031${index}`,
            id,
            row.revision,
          ),
        );
        expect(deleted.outcome).toBe("committed");
        if (deleted.outcome === "committed") {
          expect(Object.hasOwn(deleted.revisions, id)).toBe(true);
        }
      }
      expect(await session.bundles.get(id)).toBeNull();
    }
    await connection.close();
  });
});

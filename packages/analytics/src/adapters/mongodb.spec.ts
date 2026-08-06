import type { Db } from "mongodb";
import { describe, expect, expectTypeOf, it } from "vitest";

import { AnalyticsSchemaNotReadyError } from "../provider/migration";
import {
  createMongoAnalyticsPersistence,
  migrateMongoAnalyticsSchema,
  type MongoAnalyticsDatabase,
} from "./mongodb";
import {
  createMongoAnalyticsHarness,
  transitionRow,
} from "./mongodbTestHarness";

describe("MongoDB Analytics persistence", () => {
  it("accepts the official MongoDB database type", () => {
    expectTypeOf<Db>().toMatchTypeOf<MongoAnalyticsDatabase>();
  });

  it("appends a copy only after exact schema.analytics v2 readiness", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    harness.operations.splice(0);
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });
    const row = transitionRow("event-1", 10);

    await persistence.append(row);

    expect(harness.documents).toEqual([row]);
    expect(harness.operations).toEqual(["insert:event-1"]);
  });

  it("uses exclusive cursor and cutoff filters with stable ascending order", async () => {
    const event2 = transitionRow("event-2", 20);
    const event3 = transitionRow("event-3", 20);
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    harness.documents.push(
      event3,
      transitionRow("event-1", 10),
      transitionRow("at-cutoff", 30),
      event2,
    );
    harness.operations.splice(0);
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });

    const rows = await persistence.scan({
      after: { id: "event-1", receivedAtMs: 10 },
      beforeReceivedAtMs: 30,
      limit: 2,
    });

    expect(rows).toEqual([event2, event3]);
    expect(harness.getLastFilter()).toEqual({
      $and: [
        { received_at_ms: { $lt: 30 } },
        {
          $or: [
            { received_at_ms: { $gt: 10 } },
            { id: { $gt: "event-1" }, received_at_ms: 10 },
          ],
        },
      ],
    });
    expect(harness.getLastSort()).toEqual({ received_at_ms: 1, id: 1 });
    expect(harness.getLastLimit()).toBe(2);
  });

  it("retries readiness after a failed check", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    harness.settings.set("schema.analytics", "1");
    harness.operations.splice(0);
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });

    await expect(
      persistence.append(transitionRow("blocked-1", 20)),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    harness.settings.set("schema.analytics", "2");
    await persistence.append(transitionRow("accepted", 30));

    expect(harness.operations).toEqual(["insert:accepted"]);
    expect(harness.documents).toEqual([transitionRow("accepted", 30)]);
  });

  it.each(["deleted", "v1", "future"] as const)(
    "rejects a %s marker after an earlier readiness success",
    async (markerState) => {
      const harness = createMongoAnalyticsHarness();
      await migrateMongoAnalyticsSchema({ database: harness.database });
      const persistence = createMongoAnalyticsPersistence({
        database: harness.database,
      });
      await persistence.append(transitionRow("first", 10));
      if (markerState === "deleted") {
        harness.settings.delete("schema.analytics");
      } else {
        harness.settings.set(
          "schema.analytics",
          markerState === "v1" ? "1" : "3",
        );
      }

      const second = persistence.append(transitionRow("second", 20));

      await expect(second).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
      expect(harness.documents).toEqual([transitionRow("first", 10)]);
    },
  );

  it("checks the marker on every write but scans physical inventory once", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    harness.resetReadCounts();
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });
    await persistence.append(transitionRow("first", 10));
    const inventoryReads = harness.getInventoryReadCount();
    const markerReads = harness.getMarkerReadCount();

    await persistence.append(transitionRow("second", 20));

    expect(harness.getInventoryReadCount()).toBe(inventoryReads);
    expect(harness.getMarkerReadCount()).toBe(markerReads + 1);
  });

  it("invalidates full readiness after observing a non-v2 marker", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });
    await persistence.append(transitionRow("first", 10));
    harness.settings.set("schema.analytics", "3");
    await expect(
      persistence.append(transitionRow("blocked", 20)),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    harness.indexes.pop();
    harness.settings.set("schema.analytics", "2");

    const afterRestore = persistence.append(transitionRow("after-restore", 30));

    await expect(afterRestore).rejects.toBeInstanceOf(
      AnalyticsSchemaNotReadyError,
    );
    expect(harness.documents).toEqual([transitionRow("first", 10)]);
  });

  it("retries a failed full validation after the physical schema is repaired", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    const removedIndex = harness.indexes.pop();
    if (removedIndex === undefined) {
      throw new RangeError("missing MongoDB index fixture");
    }
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });
    await expect(
      persistence.append(transitionRow("blocked", 10)),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    harness.indexes.push(removedIndex);

    await persistence.append(transitionRow("accepted", 20));

    expect(harness.documents).toEqual([transitionRow("accepted", 20)]);
  });

  it("rejects duplicate event ids without replacing the first document", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    const persistence = createMongoAnalyticsPersistence({
      database: harness.database,
    });
    const first = transitionRow("duplicate", 10);

    await persistence.append(first);
    const duplicate = persistence.append(transitionRow("duplicate", 20));

    await expect(duplicate).rejects.toThrow();
    expect(harness.documents).toEqual([first]);
  });
});

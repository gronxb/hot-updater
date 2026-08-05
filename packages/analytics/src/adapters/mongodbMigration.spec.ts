import { describe, expect, it } from "vitest";

import { AnalyticsSchemaCompatibilityError } from "../provider/migration";
import {
  MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
  migrateMongoAnalyticsSchema,
} from "./mongodb";
import {
  createMongoAnalyticsHarness,
  legacyMongoIndexes,
  transitionRow,
} from "./mongodbTestHarness";

describe("MongoDB Analytics schema lifecycle", () => {
  it("creates fresh v2 artifacts before writing the component marker", async () => {
    const harness = createMongoAnalyticsHarness();

    const result = await migrateMongoAnalyticsSchema({
      database: harness.database,
    });

    expect(result).toEqual({ kind: "created-v2" });
    expect(harness.operations.at(0)).toBe("collection:v2");
    expect(harness.operations.slice(1, -1)).toHaveLength(8);
    expect(harness.operations.at(-1)).toBe("marker:2");
    expect(harness.settings.get("schema.analytics")).toBe("2");
  });

  it("migrates exact 0.37 artifacts without changing any document", async () => {
    const legacyRow = transitionRow("legacy-v1", 10);
    const harness = createMongoAnalyticsHarness({
      documents: [legacyRow],
      indexes: legacyMongoIndexes,
      legacyVersion: "0.37.0",
    });

    const result = await migrateMongoAnalyticsSchema({
      database: harness.database,
    });

    expect(result).toEqual({ kind: "migrated-v1-v2" });
    expect(harness.documents).toEqual([legacyRow]);
    expect(harness.operations).toEqual(["validator:v2", "marker:2"]);
  });

  it("adopts exact 0.38 artifacts without changing any document", async () => {
    const legacyRow = transitionRow("legacy-v2", 10);
    const harness = createMongoAnalyticsHarness({
      documents: [legacyRow],
      indexes: legacyMongoIndexes,
      legacyVersion: "0.38.0",
    });

    const result = await migrateMongoAnalyticsSchema({
      database: harness.database,
    });

    expect(result).toEqual({ kind: "adopted-v2" });
    expect(harness.documents).toEqual([legacyRow]);
    expect(harness.operations).toEqual(["marker:2"]);
  });

  it.each([null, "1"])(
    "finalizes interrupted exact v2 artifacts from marker %s",
    async (componentVersion) => {
      const harness = createMongoAnalyticsHarness();
      await migrateMongoAnalyticsSchema({ database: harness.database });
      harness.documents.push(transitionRow("recovered", 10));
      harness.operations.splice(0);
      if (componentVersion === null) {
        harness.settings.delete("schema.analytics");
      } else {
        harness.settings.set("schema.analytics", componentVersion);
      }

      const result = await migrateMongoAnalyticsSchema({
        database: harness.database,
      });

      expect(result).toEqual({ kind: "adopted-v2" });
      expect(harness.operations).toEqual(["marker:2"]);
    },
  );

  it("does no writes when marker and exact v2 artifacts are already ready", async () => {
    const seed = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: seed.database });
    seed.operations.splice(0);

    const result = await migrateMongoAnalyticsSchema({
      database: seed.database,
    });

    expect(result).toEqual({ kind: "ready" });
    expect(seed.operations).toEqual([]);
  });

  it.each([
    {
      name: "collated index",
      options: {
        documents: [transitionRow("event", 10)],
        indexes: legacyMongoIndexes.map((index) =>
          Reflect.get(index, "name") === "bundle_events_received_at_idx"
            ? { ...index, collation: { locale: "en" } }
            : index,
        ),
        legacyVersion: "0.38.0",
      },
    },
    {
      name: "capped collection",
      options: {
        collectionOptions: { capped: true },
        documents: [transitionRow("event", 10)],
        indexes: legacyMongoIndexes,
        legacyVersion: "0.38.0",
      },
    },
    {
      name: "different validator",
      options: {
        documents: [transitionRow("event", 10)],
        indexes: legacyMongoIndexes,
        legacyVersion: "0.38.0",
        validator: { $jsonSchema: { bsonType: "object" } },
      },
    },
    {
      name: "corrupt marker",
      options: {
        componentVersion: { version: "2" },
        documents: [transitionRow("event", 10)],
        indexes: legacyMongoIndexes,
        legacyVersion: "0.38.0",
      },
    },
    {
      name: "future marker",
      options: {
        componentVersion: "3",
        documents: [transitionRow("event", 10)],
        indexes: legacyMongoIndexes,
        legacyVersion: "0.38.0",
      },
    },
  ])("rejects $name before mutation", async ({ options }) => {
    const harness = createMongoAnalyticsHarness(options);

    const result = migrateMongoAnalyticsSchema({ database: harness.database });

    await expect(result).rejects.toThrow();
    expect(harness.operations).toEqual([]);
    expect(harness.settings.get("schema.analytics")).not.toBe("2");
  });

  it("rejects one missing v2 index before mutation", async () => {
    const harness = createMongoAnalyticsHarness();
    await migrateMongoAnalyticsSchema({ database: harness.database });
    harness.operations.splice(0);
    harness.indexes.pop();

    const result = migrateMongoAnalyticsSchema({ database: harness.database });

    await expect(result).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    expect(harness.operations).toEqual([]);
  });

  it("resumes a fresh v2 collection after an interrupted index phase", async () => {
    const harness = createMongoAnalyticsHarness({
      documents: [],
      indexes: legacyMongoIndexes.slice(0, 4),
      validator: MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
    });

    const result = await migrateMongoAnalyticsSchema({
      database: harness.database,
    });

    expect(result).toEqual({ kind: "created-v2" });
    expect(harness.indexes).toEqual(legacyMongoIndexes);
    expect(harness.operations.at(-1)).toBe("marker:2");
  });

  it("rejects an extra document field as drift before mutation", async () => {
    const harness = createMongoAnalyticsHarness({
      documents: [{ ...transitionRow("event", 10), unexpected: true }],
      indexes: legacyMongoIndexes,
      legacyVersion: "0.38.0",
    });

    const result = migrateMongoAnalyticsSchema({ database: harness.database });

    await expect(result).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    expect(harness.operations).toEqual([]);
  });

  it("rejects duplicate persisted ids as drift before mutation", async () => {
    const harness = createMongoAnalyticsHarness({
      documents: [
        transitionRow("duplicate", 10),
        transitionRow("duplicate", 20),
      ],
      indexes: legacyMongoIndexes,
      legacyVersion: "0.38.0",
    });

    const result = migrateMongoAnalyticsSchema({ database: harness.database });

    await expect(result).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    expect(harness.operations).toEqual([]);
  });

  it("recovers after the v2 artifacts land but the marker write fails", async () => {
    const harness = createMongoAnalyticsHarness({ failMarkerOnce: true });

    await expect(
      migrateMongoAnalyticsSchema({ database: harness.database }),
    ).rejects.toThrow();
    expect(harness.settings.has("schema.analytics")).toBe(false);
    expect(harness.operations.at(0)).toBe("collection:v2");
    expect(harness.operations).not.toContain("marker:2");

    const result = await migrateMongoAnalyticsSchema({
      database: harness.database,
    });

    expect(result).toEqual({ kind: "adopted-v2" });
    expect(harness.operations.at(-1)).toBe("marker:2");
  });
});

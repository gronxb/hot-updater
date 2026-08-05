import { describe, expect, it, vi } from "vitest";

import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  AnalyticsSchemaCompatibilityError,
  migrateAnalyticsSchema,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
} from "./migration";

const createStore = (
  inspection: AnalyticsSchemaInspection,
): AnalyticsSchemaMigrationStore & {
  readonly calls: string[];
} => {
  const calls: string[] = [];
  return {
    calls,
    inspect: vi.fn(async () => inspection),
    createV2: vi.fn(async () => {
      calls.push("create");
    }),
    migrateV1ToV2: vi.fn(async () => {
      calls.push("migrate");
    }),
    validateV2: vi.fn(async () => {
      calls.push("validate");
    }),
    writeComponentVersion: vi.fn(async () => {
      calls.push("marker");
    }),
  };
};

describe("migrateAnalyticsSchema", () => {
  it("revalidates a marked v2 schema before declaring it ready", async () => {
    const store = createStore({
      componentVersion: "2",
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      legacyVersion: "0.38.0",
    });

    await expect(migrateAnalyticsSchema(store)).resolves.toEqual({
      kind: "ready",
    });
    expect(store.calls).toEqual(["validate"]);
  });

  it("creates a fresh independent v2 schema and writes its marker last", async () => {
    const store = createStore({
      componentVersion: null,
      fingerprint: null,
      legacyVersion: "0.36.0",
    });

    await expect(migrateAnalyticsSchema(store)).resolves.toEqual({
      kind: "created-v2",
    });
    expect(store.calls).toEqual(["create", "validate", "marker"]);
  });

  it("does not write marker 2 when post-migration validation fails", async () => {
    const store = createStore({
      componentVersion: null,
      fingerprint: null,
      legacyVersion: "0.36.0",
    });
    store.validateV2 = vi.fn(async () => {
      store.calls.push("validate");
      throw new TypeError("invalid physical v2 shape");
    });

    await expect(migrateAnalyticsSchema(store)).rejects.toThrow(
      "invalid physical v2 shape",
    );
    expect(store.calls).toEqual(["create", "validate"]);
  });

  it("recovers when a v1 migration completed before marker 2 was written", async () => {
    const store = createStore({
      componentVersion: "1",
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      legacyVersion: "0.37.0",
    });

    await expect(migrateAnalyticsSchema(store)).resolves.toEqual({
      kind: "adopted-v2",
    });
    expect(store.calls).toEqual(["validate", "marker"]);
  });

  it.each([null, "0.21.0", "0.36.0", "0.37.0", "0.38.0"])(
    "adopts an exact unmarked v2 shape for known legacy version %s",
    async (legacyVersion) => {
      const store = createStore({
        componentVersion: null,
        fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
        legacyVersion,
      });

      await expect(migrateAnalyticsSchema(store)).resolves.toEqual({
        kind: "adopted-v2",
      });
      expect(store.calls).toEqual(["validate", "marker"]);
    },
  );

  it("migrates the immutable legacy 0.37 v1 shape before writing marker 2", async () => {
    const store = createStore({
      componentVersion: null,
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V1,
      legacyVersion: "0.37.0",
    });

    await expect(migrateAnalyticsSchema(store)).resolves.toEqual({
      kind: "migrated-v1-v2",
    });
    expect(store.calls).toEqual(["migrate", "validate", "marker"]);
  });

  it.each([
    {
      componentVersion: "3",
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      legacyVersion: "0.38.0",
    },
    {
      componentVersion: null,
      fingerprint: "analytics-schema-drift",
      legacyVersion: "0.38.0",
    },
    {
      componentVersion: null,
      fingerprint: null,
      legacyVersion: "0.38.0",
    },
    {
      componentVersion: null,
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      legacyVersion: "0.39.0",
    },
  ] satisfies readonly AnalyticsSchemaInspection[])(
    "fails closed for incompatible or future state",
    async (inspection) => {
      const store = createStore(inspection);

      await expect(migrateAnalyticsSchema(store)).rejects.toBeInstanceOf(
        AnalyticsSchemaCompatibilityError,
      );
      expect(store.calls).toEqual([]);
    },
  );
});

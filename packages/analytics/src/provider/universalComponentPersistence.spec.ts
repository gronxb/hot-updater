import {
  defineUniversalComponentSchema,
  UniversalComponentDataStateNotReadyError,
  type UniversalComponentDataSource,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { analyticsComponentSchema } from "../componentSchema";
import { AnalyticsSchemaNotReadyError } from "./migration";
import type { BundleEventPersistenceRow } from "./persistence";
import { InvalidBundleEventPersistenceRowError } from "./rowParser";
import { createUniversalComponentAnalyticsPersistence } from "./universalComponentPersistence";

const row: BundleEventPersistenceRow = {
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  from_bundle_id: null,
  id: "00000000-0000-4000-8000-000000000003",
  install_id: "install-1",
  platform: "ios",
  received_at_ms: 100,
  sdk_version: null,
  to_bundle_id: "00000000-0000-4000-8000-000000000002",
  type: "UNCHANGED",
  update_strategy: null,
  user_id: null,
  username: null,
};

const createSource = (
  overrides: Partial<UniversalComponentDataSource> = {},
): UniversalComponentDataSource => ({
  schema: analyticsComponentSchema,
  append: async () => undefined,
  assertReady: async () => undefined,
  orderedScan: async () => [],
  ...overrides,
});

describe("universal component Analytics persistence", () => {
  it("writes the exact bundle_events row", async () => {
    const append = vi.fn(async () => undefined);
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({ append }),
    );

    await persistence.append(row);

    expect(append).toHaveBeenCalledWith({ row, table: "bundle_events" });
  });

  it("maps Analytics cutoffs and cursors to the declared ordered scan", async () => {
    const orderedScan = vi.fn(async () => [row]);
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({ orderedScan }),
    );

    await expect(
      persistence.scan({
        after: { id: row.id, receivedAtMs: row.received_at_ms },
        beforeReceivedAtMs: 200,
        limit: 25,
      }),
    ).resolves.toEqual([row]);
    expect(orderedScan).toHaveBeenCalledWith({
      accessPattern: "bundle_events_by_received_at",
      afterExclusive: [100, row.id],
      beforePrefixExclusive: [200],
      limit: 25,
    });
  });

  it("omits the generic cursor when Analytics starts at the first row", async () => {
    const orderedScan = vi.fn(async () => []);
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({ orderedScan }),
    );

    await persistence.scan({ beforeReceivedAtMs: 200, limit: 10 });

    expect(orderedScan).toHaveBeenCalledWith({
      accessPattern: "bundle_events_by_received_at",
      beforePrefixExclusive: [200],
      limit: 10,
    });
  });

  it("reuses the canonical Analytics row parser for scanned storage", async () => {
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({
        orderedScan: async () => [{ ...row, platform: "web" }],
      }),
    );

    await expect(
      persistence.scan({ beforeReceivedAtMs: 200, limit: 10 }),
    ).rejects.toBeInstanceOf(InvalidBundleEventPersistenceRowError);
  });

  it("translates generic marker readiness without exposing provider state", async () => {
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({
        append: async () => {
          throw new UniversalComponentSchemaNotReadyError(
            "analytics",
            "2",
            "1",
          );
        },
      }),
    );

    await expect(persistence.append(row)).rejects.toEqual(
      expect.objectContaining({
        inspection: {
          componentVersion: "1",
          fingerprint: null,
          legacyVersion: null,
        },
        name: AnalyticsSchemaNotReadyError.name,
      }),
    );
  });

  it("translates generic physical readiness without exposing provider state", async () => {
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({
        orderedScan: async () => {
          throw new UniversalComponentDataStateNotReadyError(
            "analytics",
            "2",
            "stored-data",
          );
        },
      }),
    );

    await expect(
      persistence.scan({ beforeReceivedAtMs: 200, limit: 10 }),
    ).rejects.toEqual(
      expect.objectContaining({
        inspection: {
          componentVersion: null,
          fingerprint: null,
          legacyVersion: null,
        },
        name: AnalyticsSchemaNotReadyError.name,
      }),
    );
  });

  it("preserves operational provider errors", async () => {
    const operationalError = new Error("database unavailable");
    const persistence = createUniversalComponentAnalyticsPersistence(
      createSource({
        append: async () => {
          throw operationalError;
        },
      }),
    );

    await expect(persistence.append(row)).rejects.toBe(operationalError);
  });

  it("rejects a source bound to a different component contract", () => {
    const otherSchema = defineUniversalComponentSchema({
      id: "other",
      versions: [
        {
          tables: [
            {
              columns: [{ name: "id", primaryKey: true, type: "string" }],
              name: "other_records",
            },
          ],
          version: "1",
        },
      ],
    });

    expect(() =>
      createUniversalComponentAnalyticsPersistence(
        createSource({ schema: otherSchema }),
      ),
    ).toThrow("canonical component schema");
  });
});

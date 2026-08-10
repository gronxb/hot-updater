import {
  getUniversalComponentLatestSchema,
  resolveUniversalComponentMigrationState,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { analyticsComponentSchema } from "./componentSchema";
import { ANALYTICS_SCHEMA_VERSION } from "./provider";

const transitionRow = {
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  from_bundle_id: "00000000-0000-4000-8000-000000000001",
  id: "00000000-0000-4000-8000-000000000003",
  install_id: "install-1",
  platform: "ios",
  received_at_ms: 1,
  sdk_version: null,
  to_bundle_id: "00000000-0000-4000-8000-000000000002",
  type: "UPDATE_APPLIED",
  update_strategy: "fingerprint",
  user_id: null,
  username: null,
} as const;

describe("Analytics component schema", () => {
  it("owns the exact v1 and v2 bundle_events storage history", () => {
    const [version1, version2] = analyticsComponentSchema.versions;
    const table1 = version1.tables[0]!;
    const table2 = version2.tables[0]!;
    const expectedColumns = [
      "id",
      "type",
      "install_id",
      "user_id",
      "username",
      "from_bundle_id",
      "to_bundle_id",
      "platform",
      "app_version",
      "channel",
      "cohort",
      "update_strategy",
      "fingerprint_hash",
      "sdk_version",
      "received_at_ms",
    ];
    const expectedIndexes = [
      "bundle_events_installed_bundle_idx",
      "bundle_events_recovered_bundle_idx",
      "bundle_events_install_idx",
      "bundle_events_user_id_idx",
      "bundle_events_username_idx",
      "bundle_events_cohort_idx",
      "bundle_events_received_at_idx",
    ];

    expect(analyticsComponentSchema.id).toBe("analytics");
    expect([version1.version, version2.version]).toEqual(["1", "2"]);
    expect(
      getUniversalComponentLatestSchema(analyticsComponentSchema).version,
    ).toBe(ANALYTICS_SCHEMA_VERSION);
    expect(table1.name).toBe("bundle_events");
    expect(table1.columns.map(({ name }) => name)).toEqual(expectedColumns);
    expect(table2.columns.map(({ name }) => name)).toEqual(expectedColumns);
    expect(table1.indexes?.map(({ name }) => name)).toEqual(expectedIndexes);
    expect(table2.indexes?.map(({ name }) => name)).toEqual(expectedIndexes);
    expect(table1.columns.at(-1)).toEqual({
      name: "received_at_ms",
      type: "float",
    });
    expect(
      table1.columns.find(({ name }) => name === "from_bundle_id"),
    ).toEqual({ name: "from_bundle_id", type: "uuid" });
    expect(
      table2.columns.find(({ name }) => name === "from_bundle_id"),
    ).toEqual({ name: "from_bundle_id", nullable: true, type: "uuid" });
    expect(
      table1.columns.find(({ name }) => name === "update_strategy"),
    ).toEqual({ name: "update_strategy", type: "string" });
    expect(
      table2.columns.find(({ name }) => name === "update_strategy"),
    ).toEqual({
      name: "update_strategy",
      nullable: true,
      type: "string",
    });
    expect(version2.orderedScans).toEqual([
      {
        columns: ["received_at_ms", "id"],
        name: "bundle_events_by_received_at",
        table: "bundle_events",
      },
    ]);
  });

  it("keeps physical checks exact and row-only invariants out of storage", () => {
    const [version1, version2] = analyticsComponentSchema.versions;
    const checks1 = version1.tables[0]!.checks!;
    const checks2 = version2.tables[0]!.checks!;

    expect(
      checks1
        .filter(({ enforcement }) => enforcement !== "validation")
        .map(({ name }) => name),
    ).toEqual([
      "bundle_events_type_check",
      "bundle_events_update_strategy_check",
    ]);
    expect(
      checks2
        .filter(({ enforcement }) => enforcement !== "validation")
        .map(({ name }) => name),
    ).toEqual([
      "bundle_events_type_v038_check",
      "bundle_events_update_strategy_v038_check",
      "bundle_events_shape_v038_check",
    ]);
    expect(
      checks2
        .filter(({ enforcement }) => enforcement === "validation")
        .map(({ name }) => name),
    ).toEqual([
      "bundle_events_required_text_validation",
      "bundle_events_nullable_text_validation",
      "bundle_events_platform_validation",
      "bundle_events_received_at_validation",
    ]);
  });

  it("preserves legacy adoption and creation decisions", () => {
    const decide = (
      discriminatorValue: string | null,
      physicalVersion: string | null,
    ) =>
      resolveUniversalComponentMigrationState(analyticsComponentSchema, {
        discriminatorValue,
        markerVersion: null,
        physicalVersion,
      });

    expect(decide("0.36.0", null)).toEqual({
      kind: "create",
      targetVersion: "2",
    });
    expect(decide("0.38.0", null)).toEqual({ kind: "reject" });
    expect(decide("0.37.0", "1")).toEqual({
      fromVersion: "1",
      kind: "migrate",
      targetVersion: "2",
    });
    expect(decide(null, "2")).toEqual({
      fromVersion: "2",
      kind: "adopt",
      targetVersion: "2",
    });
  });

  it("enforces the existing row parser domain for both history versions", () => {
    expect(() =>
      validateUniversalComponentRow(analyticsComponentSchema, {
        row: transitionRow,
        table: "bundle_events",
        version: "1",
      }),
    ).not.toThrow();
    expect(() =>
      validateUniversalComponentRow(analyticsComponentSchema, {
        row: {
          ...transitionRow,
          from_bundle_id: null,
          type: "UNCHANGED",
          update_strategy: null,
        },
        table: "bundle_events",
        version: "2",
      }),
    ).not.toThrow();
    expect(() =>
      validateUniversalComponentRow(analyticsComponentSchema, {
        row: { ...transitionRow, platform: "web" },
        table: "bundle_events",
        version: "2",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(analyticsComponentSchema, {
        row: { ...transitionRow, received_at_ms: 0.5 },
        table: "bundle_events",
        version: "2",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(analyticsComponentSchema, {
        row: { ...transitionRow, install_id: "" },
        table: "bundle_events",
        version: "2",
      }),
    ).toThrow("Invalid row for component table");
  });
});

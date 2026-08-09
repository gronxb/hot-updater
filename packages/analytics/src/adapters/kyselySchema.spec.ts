import { describe, expect, it } from "vitest";

import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
} from "../provider/migration";
import {
  ANALYTICS_PHYSICAL_SCHEMA_V1,
  ANALYTICS_PHYSICAL_SCHEMA_V2,
} from "../provider/schemaFingerprint";
import { classifyKyselyAnalyticsSchema } from "./kyselySchema";
import type {
  KyselyAnalyticsCatalog,
  KyselyAnalyticsCatalogCheck,
} from "./kyselySchemaCatalog";

const mysqlV1Checks = [
  {
    definition:
      "(`type` in (_utf8mb4\\'UPDATE_APPLIED\\',_utf8mb4\\'RECOVERED\\'))",
    enforced: true,
    name: "bundle_events_type_check",
  },
  {
    definition:
      "(`update_strategy` in (_utf8mb4\\'fingerprint\\',_utf8mb4\\'appVersion\\'))",
    enforced: true,
    name: "bundle_events_update_strategy_check",
  },
] as const;

const v2Checks = [
  {
    definition:
      "CHECK ((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text, 'UNCHANGED'::text])))",
    enforced: true,
    name: "bundle_events_type_v038_check",
  },
  {
    definition:
      "CHECK (((update_strategy IS NULL) OR (update_strategy = ANY (ARRAY['fingerprint'::text, 'appVersion'::text]))))",
    enforced: true,
    name: "bundle_events_update_strategy_v038_check",
  },
  {
    definition:
      "CHECK ((((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text])) AND (from_bundle_id IS NOT NULL) AND (update_strategy IS NOT NULL)) OR ((type = 'UNCHANGED'::text) AND (from_bundle_id IS NULL) AND (update_strategy IS NULL))))",
    enforced: true,
    name: "bundle_events_shape_v038_check",
  },
] as const;

const mysqlV2Checks = [
  {
    definition:
      "(`type` in (_utf8mb4\\'UPDATE_APPLIED\\',_utf8mb4\\'RECOVERED\\',_utf8mb4\\'UNCHANGED\\'))",
    enforced: true,
    name: "bundle_events_type_v038_check",
  },
  {
    definition:
      "((`update_strategy` is null) or (`update_strategy` in (_utf8mb4\\'fingerprint\\',_utf8mb4\\'appVersion\\')))",
    enforced: true,
    name: "bundle_events_update_strategy_v038_check",
  },
  {
    definition:
      "(((`type` in (_utf8mb4\\'UPDATE_APPLIED\\',_utf8mb4\\'RECOVERED\\')) and (`from_bundle_id` is not null) and (`update_strategy` is not null)) or ((`type` = _utf8mb4\\'UNCHANGED\\') and (`from_bundle_id` is null) and (`update_strategy` is null)))",
    enforced: true,
    name: "bundle_events_shape_v038_check",
  },
] as const;

const catalog = (
  checks: readonly KyselyAnalyticsCatalogCheck[],
  columns = ANALYTICS_PHYSICAL_SCHEMA_V2.columns,
  invalidIndexes: readonly string[] = [],
): KyselyAnalyticsCatalog => ({
  checks,
  columns,
  foreignKeys: [],
  indexes: ANALYTICS_PHYSICAL_SCHEMA_V2.indexes,
  invalidIndexes,
  primaryKey: ["id"],
  unexpectedConstraints: [],
});

describe("classifyKyselyAnalyticsSchema", () => {
  it("recognizes PostgreSQL-normalized v2 check definitions", () => {
    expect(
      classifyKyselyAnalyticsSchema(catalog(v2Checks), "postgresql"),
    ).toEqual({
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      mysqlResumeIndex: null,
    });
  });

  it("rejects a changed check that reuses the expected name", () => {
    const changed = v2Checks.map((check) =>
      check.name === "bundle_events_shape_v038_check"
        ? { ...check, definition: "true" }
        : check,
    );

    expect(
      classifyKyselyAnalyticsSchema(catalog(changed), "postgresql").fingerprint,
    ).toBe("analytics-schema-drift");
  });

  it("preserves quoted enum literals while normalizing checks", () => {
    const changed = v2Checks.map((check) =>
      check.name === "bundle_events_type_v038_check"
        ? {
            ...check,
            definition: check.definition.replace(
              "UPDATE_APPLIED",
              "UPDATE_REJECTED",
            ),
          }
        : check,
    );

    expect(
      classifyKyselyAnalyticsSchema(catalog(changed), "postgresql").fingerprint,
    ).toBe("analytics-schema-drift");
  });

  it("rejects a check with the same tokens but different grouping", () => {
    const changed = v2Checks.map((check) =>
      check.name === "bundle_events_shape_v038_check"
        ? {
            ...check,
            definition:
              "CHECK ((((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text])) AND (from_bundle_id IS NOT NULL) AND ((update_strategy IS NOT NULL) OR (type = 'UNCHANGED'::text)) AND (from_bundle_id IS NULL) AND (update_strategy IS NULL))))",
          }
        : check,
    );

    expect(
      classifyKyselyAnalyticsSchema(catalog(changed), "postgresql").fingerprint,
    ).toBe("analytics-schema-drift");
  });

  it("rejects a changed MySQL v2 check with the expected name", () => {
    const changed = mysqlV2Checks.map((check) =>
      check.name === "bundle_events_type_v038_check"
        ? { ...check, definition: "type is not null" }
        : check,
    );

    expect(
      classifyKyselyAnalyticsSchema(catalog(changed), "mysql").fingerprint,
    ).toBe("analytics-schema-drift");
  });

  it("recognizes MySQL-normalized v2 check definitions", () => {
    expect(
      classifyKyselyAnalyticsSchema(catalog(mysqlV2Checks), "mysql"),
    ).toEqual({
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V2,
      mysqlResumeIndex: null,
    });
  });

  it("rejects invalid, invisible, partial, or wrong-prefix indexes", () => {
    expect(
      classifyKyselyAnalyticsSchema(
        catalog(v2Checks, ANALYTICS_PHYSICAL_SCHEMA_V2.columns, [
          "bundle_events_install_idx",
        ]),
        "mysql",
      ).fingerprint,
    ).toBe("analytics-schema-drift");
  });

  it.each([
    {
      checks: [{ ...mysqlV1Checks[0], enforced: false }, mysqlV1Checks[1]],
      columns: ANALYTICS_PHYSICAL_SCHEMA_V1.columns,
      resumeIndex: 1,
    },
    {
      checks: mysqlV1Checks.map((check) => ({ ...check, enforced: false })),
      columns: ANALYTICS_PHYSICAL_SCHEMA_V1.columns.map((column) =>
        column.name === "from_bundle_id"
          ? { ...column, nullable: true }
          : column,
      ),
      resumeIndex: 3,
    },
    {
      checks: [
        ...mysqlV1Checks.map((check) => ({ ...check, enforced: false })),
        ...mysqlV2Checks.slice(0, 2),
      ],
      columns: ANALYTICS_PHYSICAL_SCHEMA_V2.columns,
      resumeIndex: 6,
    },
  ])(
    "resumes only a known MySQL migration prefix %#",
    ({ checks, columns, resumeIndex }) => {
      expect(
        classifyKyselyAnalyticsSchema(catalog(checks, columns), "mysql"),
      ).toEqual({
        fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V1,
        mysqlResumeIndex: resumeIndex,
      });
    },
  );
});

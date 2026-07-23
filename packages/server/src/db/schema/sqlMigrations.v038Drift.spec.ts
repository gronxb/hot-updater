import { describe, expect, it } from "vitest";

import type { HotUpdaterVersionedSchema } from "../../schema/types";
import { v0_37_0 } from "../../schema/v0_37_0";
import { v0_38_0 } from "../../schema/v0_38_0";
import { assertV038MigrationSchemaDriftIsAllowlisted } from "./schemaDriftValidatorV038";

describe("0.37.0 to 0.38.0 SQL migration drift validation", () => {
  it("accepts only the immutable canonical schema pair", () => {
    // When / Then
    expect(() =>
      assertV038MigrationSchemaDriftIsAllowlisted(v0_37_0, v0_38_0),
    ).not.toThrow();
  });

  it("rejects drift in the immutable 0.37.0 source schema", () => {
    // Given
    const previous = {
      ...v0_37_0,
      tables: v0_37_0.tables.map((table) =>
        table.ormName === "bundle_events"
          ? {
              ...table,
              columns: table.columns.map((column) =>
                column.ormName === "id"
                  ? { ...column, nullable: true as const }
                  : column,
              ),
            }
          : table,
      ),
    } satisfies HotUpdaterVersionedSchema;

    // When / Then
    expect(() =>
      assertV038MigrationSchemaDriftIsAllowlisted(previous, v0_38_0),
    ).toThrow("Unsupported Hot Updater schema change at 0.37.0");
  });

  it("rejects drift beyond the explicit 0.38.0 migration shape", () => {
    // Given
    const next = {
      ...v0_38_0,
      tables: v0_38_0.tables.map((table) =>
        table.ormName === "bundle_events"
          ? {
              ...table,
              indexes: [
                ...(table.indexes ?? []),
                {
                  name: "bundle_events_unplanned_idx",
                  columns: ["platform"],
                },
              ],
            }
          : table,
      ),
    } satisfies HotUpdaterVersionedSchema;

    // When / Then
    expect(() =>
      assertV038MigrationSchemaDriftIsAllowlisted(v0_37_0, next),
    ).toThrow("Unsupported Hot Updater schema change at 0.38.0");
  });
});

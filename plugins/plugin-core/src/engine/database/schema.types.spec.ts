import { describe, expectTypeOf, it } from "vitest";

import {
  type CheckIndex,
  defineAggregate,
  defineTable,
  type RowOf,
} from "./schema";

const fields = {
  id: { type: "string", maxLength: 36 },
  size: { type: "integer" },
  note: { type: "string", required: false },
  meta: { type: "json" },
} as const;

describe("schema DSL types", () => {
  it("types a row from its fields, optional fields as nullable", () => {
    expectTypeOf<RowOf<typeof fields>>().toEqualTypeOf<{
      id: string;
      size: number;
      note: string | null;
      meta: import("@hot-updater/plugin-core/internal").DatabaseJson;
    }>();
  });

  it("types derived compute over the declared row", () => {
    defineTable(fields, {
      key: ["id"],
      derived: {
        bucket: {
          type: "integer",
          compute: (row) => {
            expectTypeOf(row.size).toEqualTypeOf<number>();
            expectTypeOf(row.note).toEqualTypeOf<string | null>();
            return row.size - (row.size % 10);
          },
        },
        words: {
          type: "string",
          multi: true,
          compute: (row) => row.note?.split(" ") ?? null,
        },
      },
      indexes: { byBucket: { eq: ["bucket"], sort: ["size"] } },
    });

    defineTable(fields, {
      key: ["id"],
      derived: {
        // @ts-expect-error An integer field cannot compute a string.
        bucket: { type: "integer", compute: (row) => row.id },
      },
    });
  });

  it("rejects an undeclared key or index field and names it", () => {
    // @ts-expect-error "missing" is not a declared field.
    defineTable(fields, { key: ["missing"] });

    defineTable(fields, {
      key: ["id"],
      indexes: {
        // @ts-expect-error The index names an undeclared field.
        byMissing: { eq: ["missing"], sort: ["size"] },
      },
    });

    expectTypeOf<
      CheckIndex<
        "byMissing",
        { eq: ["missing"]; sort: ["size"] },
        "id" | "size"
      >
    >().toEqualTypeOf<'Index "byMissing" names undeclared field "missing"'>();
    expectTypeOf<
      CheckIndex<"bySize", { eq: []; sort: ["size"] }, "id" | "size">
    >().toEqualTypeOf<{ eq: []; sort: ["size"] }>();
  });

  it("keys aggregates by identity fields only", () => {
    const totals = defineAggregate(
      { platform_key: { type: "string", maxLength: 16 } },
      { key: ["platform_key"], counters: ["bundles"] },
    );
    expectTypeOf(totals.counters).toEqualTypeOf<readonly "bundles"[]>();

    defineAggregate(
      { platform_key: { type: "string" } },
      // @ts-expect-error A metric is not an identity field.
      { key: ["bundles"], counters: ["bundles"] },
    );
  });
});

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { createTableSql } from "../db/schema/sql";
import { v1_0_0 } from "./v1_0_0";

describe("patch relation pagination indexes", () => {
  it.each(["bundle_id", "base_bundle_id"])(
    "seeks a %s page without sorting or filtering relation history",
    async (field) => {
      const db = new PGlite();
      try {
        await db.exec(
          createTableSql("postgresql", "foreign-keys", v1_0_0).join(";"),
        );
        // Inspect the available index path even on a newly initialized database.
        await db.exec("set enable_seqscan = off; set enable_bitmapscan = off");
        const result = await db.query<{
          "QUERY PLAN": [{ Plan: { Plans: Record<string, unknown>[] } }];
        }>(
          `explain (format json) select * from bundle_patches
           where ${field} = $1 and id > $2 order by id limit 100`,
          ["00000000-0000-0000-0000-000000000001", "patch-100"],
        );
        const scan = result.rows[0]["QUERY PLAN"][0].Plan.Plans[0];
        expect(scan["Node Type"]).toBe("Index Scan");
        expect(scan["Index Name"]).toBe(`bundle_patches_${field}_idx`);
        expect(scan["Index Cond"]).toContain(field);
        expect(scan["Index Cond"]).toMatch(/\bid\b[^>]*>/);
        expect(scan).not.toHaveProperty("Filter");
      } finally {
        await db.close();
      }
    },
  );
});

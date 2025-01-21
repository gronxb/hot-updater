import { describe, expect, it } from "vitest";
import { parseR2Output } from "./parseR2Output";

describe("cloudflareD1R2", () => {
  it("should return empty array when no buckets exist", async () => {
    const result = await parseR2Output(`
⛅️ wrangler 3.103.2
--------------------

Listing buckets...`);
    expect(result).toEqual([]);
  });

  it("should correctly parse when one bucket exists", async () => {
    const result = await parseR2Output(`
 ⛅️ wrangler 3.103.2
--------------------

Listing buckets...
name:           bundles
creation_date:  2025-01-21T15:55:24.480Z`);
    expect(result).toEqual([
      {
        name: "bundles",
        creation_date: "2025-01-21T15:55:24.480Z",
      },
    ]);
  });

  it("should correctly parse all buckets when multiple exist", async () => {
    const result = await parseR2Output(`
 ⛅️ wrangler 3.103.2
--------------------

Listing buckets...
name:           bundles2
creation_date:  2025-01-21T15:59:57.183Z

name:           bundles
creation_date:  2025-01-21T15:55:24.480Z`);
    expect(result).toEqual([
      {
        name: "bundles2",
        creation_date: "2025-01-21T15:59:57.183Z",
      },
      {
        name: "bundles",
        creation_date: "2025-01-21T15:55:24.480Z",
      },
    ]);
  });
});

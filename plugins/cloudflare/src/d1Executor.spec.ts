import { describe, expect, it } from "vitest";

import { retryingReads } from "./d1Executor";

const lost = () => new Error("D1_ERROR: Network connection lost.");

describe("retryingReads", () => {
  it.each([
    'CREATE TABLE IF NOT EXISTS "t" ("id" TEXT)',
    'ALTER TABLE "t" ADD COLUMN "c" TEXT',
    'INSERT INTO "t" ("id") VALUES (?)',
    'WITH x AS (SELECT 1) DELETE FROM "t"',
  ])("runs %j once, since it may have applied", async (sql) => {
    let calls = 0;
    const query = retryingReads(async () => {
      calls += 1;
      throw lost();
    });
    await expect(query({ sql, params: [] })).rejects.toThrow(
      "Network connection lost.",
    );
    expect(calls).toBe(1);
  });

  it("reads again after a transient error", async () => {
    let calls = 0;
    const query = retryingReads(async () => {
      calls += 1;
      if (calls === 1) throw lost();
      return { rows: [{ id: "a" }], changes: 0 };
    });
    await expect(
      query({ sql: '  select * FROM "t"', params: [] }),
    ).resolves.toEqual({ rows: [{ id: "a" }], changes: 0 });
    expect(calls).toBe(2);
  });
});

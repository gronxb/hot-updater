import { expect, it } from "vitest";

import { createD1Implementation, type D1Statement } from "./d1Implementation";

it("guards every write when an aggregate update target is missing", async () => {
  const existingId = "00000000-0000-0000-0000-000000000001";
  const missingId = "00000000-0000-0000-0000-000000000002";
  let recorded: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      recorded = statements;
      return statements.map((_, index) =>
        index === 0 ? [{ id: existingId }] : [],
      );
    },
  });

  const result = await implementation.commit?.({
    mutations: [
      {
        operation: "update",
        bundleId: existingId,
        changes: [
          {
            table: "bundles",
            operation: "update",
            id: existingId,
            update: { message: "first" },
          },
        ],
      },
      {
        operation: "update",
        bundleId: missingId,
        changes: [
          {
            table: "bundles",
            operation: "update",
            id: missingId,
            update: { message: "second" },
          },
        ],
      },
    ],
  });

  expect(result).toEqual({ applied: false, missingBundleId: missingId });
  expect(recorded.slice(0, 2).map(({ sql }) => sql)).toEqual([
    "SELECT id FROM bundles WHERE id = json_extract(?, '$') LIMIT 1",
    "SELECT id FROM bundles WHERE id = json_extract(?, '$') LIMIT 1",
  ]);
  expect(recorded.slice(2)).toHaveLength(2);
  for (const statement of recorded.slice(2)) {
    expect(statement.sql).toContain(
      "NOT EXISTS (SELECT 1 FROM json_each(?) AS required",
    );
    expect(statement.params).toContain(JSON.stringify([existingId, missingId]));
  }
});

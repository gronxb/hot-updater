import { expect, it } from "vitest";

import type { D1Executor } from "./d1Implementation";
import { countD1Rows, D1QueryResultError } from "./d1Query";

const countWithResult = (result: readonly unknown[]): Promise<number> => {
  const executor: D1Executor = {
    query: async () => result,
  };

  return countD1Rows(executor, { model: "bundles" });
};

it("preserves a zero count", async () => {
  // Given / When
  const count = countWithResult([{ count: 0 }]);

  // Then
  await expect(count).resolves.toBe(0);
});

it.each([
  ["a missing first row", []],
  ["a null first row", [null]],
  ["a primitive first row", ["invalid"]],
  ["an array first row", [[0]]],
  ["a missing count property", [{}]],
  ["a numeric string count", [{ count: "1" }]],
  ["a NaN count", [{ count: Number.NaN }]],
  ["an infinite count", [{ count: Number.POSITIVE_INFINITY }]],
] as const)("rejects %s", async (_description, rows) => {
  // Given / When
  const count = countWithResult(rows);

  // Then
  await expect(count).rejects.toBeInstanceOf(D1QueryResultError);
});

it("includes the malformed count row in the provider error", async () => {
  // Given
  const row = { count: "1" };

  // When
  const count = countWithResult([row]);

  // Then
  await expect(count).rejects.toMatchObject({
    name: "D1QueryResultError",
    operation: "count",
    result: row,
  });
});

import { expect } from "vitest";

/** Allow committed secondary indexes to catch up; query failures still fail. */
export const expectInsightsIndex = async <T>(
  query: () => Promise<T>,
  expected: T,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    // Keep native errors outside the assertion retry handler.
    const actual = await query();
    try {
      expect(actual).toEqual(expected);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

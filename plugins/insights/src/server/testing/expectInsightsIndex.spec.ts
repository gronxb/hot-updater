import { afterEach, describe, expect, it, vi } from "vitest";

import { expectInsightsIndex } from "./expectInsightsIndex";

afterEach(() => vi.useRealTimers());

describe("Insights index assertions", () => {
  it("waits for acknowledged writes to become visible in a lagging index", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(["report"]);
    const result = expectInsightsIndex(query, ["report"]);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("propagates a native query failure even after an earlier incomplete result", async () => {
    vi.useFakeTimers();
    const failure = new Error("native index unavailable");
    const query = vi.fn().mockResolvedValueOnce([]).mockRejectedValue(failure);
    const result = expect(expectInsightsIndex(query, ["report"])).rejects.toBe(
      failure,
    );
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails with the actual result when the bounded catch-up interval expires", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValue([]);
    const result = expect(
      expectInsightsIndex(query, ["report"]),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(query).toHaveBeenCalledTimes(101);
  });
});

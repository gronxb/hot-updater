import { describe, expect, it } from "vitest";

import {
  addInsightsDistinct,
  countInsightsDistinct,
  emptyInsightsDistinct,
  mergeInsightsDistinct,
} from "./insightsDistinctSummary";

describe("Insights distinct summaries", () => {
  it("merges overlapping installation populations without summing duplicates", () => {
    let first = emptyInsightsDistinct();
    let second = emptyInsightsDistinct();
    for (let index = 0; index < 5_000; index += 1) {
      first = addInsightsDistinct(first, `installation-${index}`);
    }
    for (let index = 2_500; index < 7_500; index += 1) {
      second = addInsightsDistinct(second, `installation-${index}`);
    }

    const estimate = countInsightsDistinct(
      mergeInsightsDistinct([first, second]),
    );
    expect(Math.abs(estimate - 7_500) / 7_500).toBeLessThan(0.08);
  });

  it("keeps repeated observations and empty summaries stable", () => {
    const empty = emptyInsightsDistinct();
    const once = addInsightsDistinct(empty, "installation-a");
    const repeated = addInsightsDistinct(once, "installation-a");
    expect(countInsightsDistinct(empty)).toBe(0);
    expect(repeated).toBe(once);
    expect(countInsightsDistinct(repeated)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import { getInsightsErrorCopy } from "./insights-error";

describe("getInsightsErrorCopy", () => {
  it("returns narrowing guidance for the bounded Insights scan limit", () => {
    // Given
    const error = new Error("Bundle event scan exceeded 50000 rows.");

    // When
    const copy = getInsightsErrorCopy(error, "Insights unavailable");

    // Then
    expect(copy).toEqual({
      title: "Insights report limit reached",
      description:
        "This query matched more than 50,000 reports. Narrow the query and try again.",
    });
  });

  it("preserves ordinary Insights errors", () => {
    // Given
    const error = new Error("Request failed");

    // When
    const copy = getInsightsErrorCopy(error, "Insights unavailable");

    // Then
    expect(copy).toEqual({
      title: "Insights unavailable",
      description: "Request failed",
    });
  });
});

import { describe, expect, it } from "vitest";

import { getAnalyticsErrorCopy } from "./analytics-error";

describe("getAnalyticsErrorCopy", () => {
  it("returns dedicated guidance for the bounded Analytics scan limit", () => {
    // Given
    const error = new Error("Bundle event scan exceeded 50000 rows.");

    // When
    const copy = getAnalyticsErrorCopy(error, "Analytics unavailable");

    // Then
    expect(copy).toEqual({
      title: "Analytics report limit reached",
      description:
        "This query matched more than 50,000 reports. Narrow the query or configure a dedicated Analytics service.",
    });
  });

  it("preserves ordinary Analytics errors", () => {
    // Given
    const error = new Error("Request failed");

    // When
    const copy = getAnalyticsErrorCopy(error, "Analytics unavailable");

    // Then
    expect(copy).toEqual({
      title: "Analytics unavailable",
      description: "Request failed",
    });
  });
});

import { describe, expect, it } from "vitest";

import { getInsightsErrorCopy } from "./insights-error";

describe("getInsightsErrorCopy", () => {
  it("explains the query limit without implying stored data is lost", () => {
    // Given
    const error = new Error("Bundle event scan exceeded 50000 rows.");

    // When
    const copy = getInsightsErrorCopy(error, "Insights unavailable");

    // Then
    expect(copy).toEqual({
      title: "Insights report limit reached",
      description:
        "This view needs to read more than 50,000 events. The data is still stored, but this provider cannot query it at this volume.",
    });
  });

  it("offers a next action without exposing internal error messages", () => {
    // Given
    const error = new Error("Request failed");

    // When
    const copy = getInsightsErrorCopy(error, "Insights unavailable");

    // Then
    expect(copy).toEqual({
      title: "Insights unavailable",
      description:
        "Refresh to try again. If this keeps happening, check your Insights provider connection.",
    });
  });
});

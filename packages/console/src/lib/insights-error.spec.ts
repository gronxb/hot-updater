import { describe, expect, it } from "vitest";

import { getInsightsErrorCopy } from "./insights-error";

describe("getInsightsErrorCopy", () => {
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

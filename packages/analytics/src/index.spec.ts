import { describe, expect, it } from "vitest";

import * as analyticsRoot from "./index";

describe("@hot-updater/analytics root", () => {
  it("exports only the supported runtime surface", () => {
    expect(Object.keys(analyticsRoot).sort()).toEqual([
      "ANALYTICS_EVENT_BODY_MAX_BYTES",
      "AnalyticsScanLimitExceededError",
      "AnalyticsUnavailableError",
      "analytics",
    ]);
  });
});

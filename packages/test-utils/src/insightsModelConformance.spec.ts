import { expect, it } from "vitest";

import { registerInsightsModelTests } from "./insightsModelConformance";
import { createInsightsModelOracle } from "./insightsModelOracle";

it("requires distinct canonical database namespace UUIDs", () => {
  expect(() =>
    createInsightsModelOracle({
      insightsDatabaseNamespace: "primary",
      otherInsightsDatabaseNamespace: "00000000-0000-7000-8000-000000000002",
    }),
  ).toThrow("distinct UUIDs");
  expect(() =>
    createInsightsModelOracle({
      insightsDatabaseNamespace: "00000000-0000-7000-8000-000000000001",
      otherInsightsDatabaseNamespace: "00000000-0000-7000-8000-000000000001",
    }),
  ).toThrow("distinct UUIDs");
});

registerInsightsModelTests(createInsightsModelOracle);

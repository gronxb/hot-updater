import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { fromStoredBundleRow } from "./databaseAdapterUtils";

describe("fromStoredBundleRow", () => {
  it.each(['["stable",42]', "not-json", { cohort: "stable" }])(
    "rejects invalid target_cohorts values",
    (targetCohorts) => {
      expect(() =>
        fromStoredBundleRow({
          ...createBundleRowFixture("invalid-cohorts"),
          target_cohorts: targetCohorts,
        }),
      ).toThrow("Invalid target_cohorts");
    },
  );
});

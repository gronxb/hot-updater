import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { fromStoredBundleRow } from "./databasePluginUtils";

describe("fromStoredBundleRow", () => {
  it("parses JSON-object metadata from SQL text storage", () => {
    const row = fromStoredBundleRow({
      ...createBundleRowFixture("valid-metadata"),
      metadata: '{"release":{"flags":[true,null,3]}}',
    });

    expect(row.metadata).toEqual({
      release: { flags: [true, null, 3] },
    });
  });

  it.each(["null", "[]", "1", '"metadata"', "not-json"])(
    "rejects non-object SQL metadata %s",
    (metadata) => {
      expect(() =>
        fromStoredBundleRow({
          ...createBundleRowFixture("invalid-metadata"),
          metadata,
        }),
      ).toThrow("Invalid metadata");
    },
  );

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

import { describe, expect, it } from "vitest";

import { normalizeInsightsRcEvent } from "../../../../scripts/insights-rc-export";
import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";

describe("offline Insights RC event conversion", () => {
  it("preserves identity, receipt time, nulls and API state through normal replay", async () => {
    const target = createInMemoryDatabasePlugin().models.insights;
    const downloaded = {
      ...createBundleEventRowFixture("990", 100),
      type: "UPDATE_DOWNLOADED" as const,
      from_bundle_id: "running",
    };
    const { metadata, ...columns } = downloaded;
    const original = { ...columns, ...metadata };
    const converted = normalizeInsightsRcEvent(original);
    expect(converted).toEqual(downloaded);
    expect(original).toEqual({ ...columns, ...metadata });
    // The fixture establishes the exact type; storage validates it again.
    await target.recordEvent({ event: converted as typeof downloaded });
    await expect(
      target.findLatestEvents({ installId: downloaded.install_id }),
    ).resolves.toEqual([downloaded]);
    expect(normalizeInsightsRcEvent(downloaded)).toEqual(downloaded);
  });

  it("rejects incomplete or ambiguous exports without guessing historical data", () => {
    expect(() => normalizeInsightsRcEvent({ id: "event" })).toThrow(
      "Missing legacy",
    );
    expect(() =>
      normalizeInsightsRcEvent({ metadata: {}, cohort: "old" }),
    ).toThrow("Mixed event metadata");
  });
});

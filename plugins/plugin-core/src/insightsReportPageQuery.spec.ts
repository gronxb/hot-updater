import { describe, expect, it } from "vitest";

import {
  createInsightsReportPageCursor,
  readInsightsReportPageQuery,
} from "./insightsReportPageQuery";
import type { InsightsReportPageInput } from "./types/insightsQueries";

const base = { publicationId: "publication-a", limit: 10 };
const input: InsightsReportPageInput = {
  ...base,
  section: "movementSeries",
  metric: "installed",
};
const MAX_ORDINAL = "9223372036854775807";

describe("Insights materialized report page identity", () => {
  it("canonicalizes every section and starts at rank zero without a cursor", () => {
    const inputs: InsightsReportPageInput[] = [
      input,
      { ...base, section: "movementCohorts", metric: "recovered" },
      { ...base, section: "bundleDistribution" },
      { ...base, section: "activeSeries" },
      { ...base, section: "activeBundleSeries" },
      { ...base, section: "activeBundleSeries", bundleId: "bundle-a" },
    ];
    for (const page of inputs) {
      const result = readInsightsReportPageQuery(page);
      expect(result.input).toEqual(page);
      expect(result.nextOrdinal).toBe("0");
      expect(result.input).not.toBe(page);
      expect(JSON.parse(result.semanticKey)).toEqual([
        page.publicationId,
        page.section,
        "metric" in page ? page.metric : null,
        "bundleId" in page ? page.bundleId : null,
      ]);
    }
  });

  it("keeps the persisted ordinal exact above Number.MAX_SAFE_INTEGER and permits page-size changes", () => {
    const cursor = createInsightsReportPageCursor(input, MAX_ORDINAL);
    const resumed = readInsightsReportPageQuery({
      ...input,
      cursor,
      limit: 100,
    });
    expect(resumed.nextOrdinal).toBe(MAX_ORDINAL);
    expect(resumed.input).toEqual({ ...input, limit: 100 });
    expect(resumed.input).not.toHaveProperty("cursor");
    expect(resumed.semanticKey).toBe(
      readInsightsReportPageQuery(input).semanticKey,
    );
    expect(JSON.parse(cursor)).toEqual([1, resumed.semanticKey, MAX_ORDINAL]);
  });

  it("rejects cursors from another publication, section, metric, or exact bundle filter", () => {
    const movementCursor = createInsightsReportPageCursor(input, "10");
    for (const change of [
      { publicationId: "publication-b" },
      { section: "movementCohorts" },
      { metric: "recovered" },
    ])
      expect(() =>
        readInsightsReportPageQuery({
          ...input,
          ...change,
          cursor: movementCursor,
        } as InsightsReportPageInput),
      ).toThrow("invalid-query");
    const filtered: InsightsReportPageInput = {
      ...base,
      section: "activeBundleSeries",
      bundleId: "bundle-a",
    };
    const cursor = createInsightsReportPageCursor(filtered, "10");
    for (const bundleId of [undefined, "bundle-b", "bundle-A", " bundle-a "])
      expect(() =>
        readInsightsReportPageQuery({ ...filtered, bundleId, cursor }),
      ).toThrow("invalid-query");
    const unfiltered = { ...base, section: "activeBundleSeries" as const };
    expect(() =>
      readInsightsReportPageQuery({
        ...filtered,
        cursor: createInsightsReportPageCursor(unfiltered, "10"),
      }),
    ).toThrow("invalid-query");
  });

  it("preserves opaque identifiers, including NUL and Unicode without normalization", () => {
    for (const id of ["\0", "\ud800", "\udfff", "🚀", "é", "e\u0301", " "]) {
      const page: InsightsReportPageInput = {
        publicationId: id,
        section: "activeBundleSeries",
        bundleId: id,
        limit: 1,
      };
      const cursor = createInsightsReportPageCursor(page, "0");
      expect(readInsightsReportPageQuery({ ...page, cursor }).input).toEqual(
        page,
      );
      expect(() =>
        readInsightsReportPageQuery({ ...page, bundleId: `${id}x`, cursor }),
      ).toThrow("invalid-query");
    }
    const key = (bundleId: string) =>
      readInsightsReportPageQuery({
        ...base,
        section: "activeBundleSeries",
        bundleId,
      }).semanticKey;
    expect(key("é")).not.toBe(key("e\u0301"));
    expect(key("a\0b")).not.toBe(key("ab"));
  });

  it("round-trips both longest identifiers with worst-case nested JSON escaping", () => {
    const page: InsightsReportPageInput = {
      publicationId: "\ud800".repeat(1_024),
      section: "activeBundleSeries",
      bundleId: "\0".repeat(1_024),
      limit: 100,
    };
    const cursor = createInsightsReportPageCursor(page, MAX_ORDINAL);
    expect(cursor.length).toBe(14_403);
    expect(cursor.length).toBeLessThanOrEqual(16_384);
    expect(readInsightsReportPageQuery({ ...page, cursor }).nextOrdinal).toBe(
      MAX_ORDINAL,
    );
    expect(() =>
      readInsightsReportPageQuery({
        ...page,
        cursor: `${cursor}${" ".repeat(16_385 - cursor.length)}`,
      }),
    ).toThrow("invalid-query");
  });

  it("rejects malformed page requests instead of silently ignoring invalid filters", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...input, publicationId: "" },
      { ...input, publicationId: "a".repeat(1_025) },
      { ...input, publicationId: null },
      { ...input, limit: 0 },
      { ...input, limit: 101 },
      { ...input, limit: 1.5 },
      { ...input, limit: Number.NaN },
      { ...input, limit: "1" },
      { ...input, limit: null },
      { ...input, cursor: null },
      { ...input, offset: 1 },
      { ...input, bundleId: undefined },
      { ...input, metric: null },
      { ...input, metric: undefined },
      { ...input, metric: "active" },
      { ...input, section: "unknown" },
      { ...base, section: "activeSeries", metric: undefined },
      { ...base, section: "bundleDistribution", bundleId: "a" },
      { ...base, section: "activeBundleSeries", bundleId: null },
      { ...base, section: "activeBundleSeries", bundleId: "" },
      { ...base, section: "activeBundleSeries", bundleId: "a".repeat(1_025) },
    ];
    for (const page of invalid)
      expect(() =>
        readInsightsReportPageQuery(page as InsightsReportPageInput),
      ).toThrow("invalid-query");
    const page = {
      ...base,
      section: "activeBundleSeries" as const,
      bundleId: undefined,
      cursor: undefined,
    };
    expect(readInsightsReportPageQuery(page).input).toEqual({
      ...base,
      section: "activeBundleSeries",
    });
  });

  it("rejects malformed, noncanonical and overflowing rank cursors without legacy decoding", () => {
    const key = readInsightsReportPageQuery(input).semanticKey;
    const badRanks = [
      "",
      "00",
      "01",
      "-1",
      "-0",
      "+1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "1\n",
      "９",
      "9223372036854775808",
      "10000000000000000000",
      1,
      null,
    ];
    for (const rank of badRanks) {
      expect(() =>
        readInsightsReportPageQuery({
          ...input,
          cursor: JSON.stringify([1, key, rank]),
        }),
      ).toThrow("invalid-query");
      expect(() =>
        createInsightsReportPageCursor(input, rank as string),
      ).toThrow("invalid-result");
    }
    for (const value of [
      null,
      {},
      [1, key],
      [1, key, "1", "extra"],
      [2, key, "1"],
      ["1", key, "1"],
      [1, JSON.parse(key), "1"],
      [1, "old-scope", 10],
    ])
      expect(() =>
        readInsightsReportPageQuery({
          ...input,
          cursor: JSON.stringify(value),
        }),
      ).toThrow("invalid-query");
    for (const cursor of ["", "not-json", "[", " ".repeat(16_385)])
      expect(() => readInsightsReportPageQuery({ ...input, cursor })).toThrow(
        "invalid-query",
      );
  });
});

import { describe, expect, it } from "vitest";

import { readInsightsReportQuery } from "./insightsReportQuery";
import type {
  InsightsReportInput,
  InsightsReportQuery,
} from "./types/insightsQueries";

describe("durable Insights report identity", () => {
  it("reuses one query identity across changing freshness and batch order", () => {
    const first = readInsightsReportQuery({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["b", "a", "b"],
        window: "7d",
      },
      minAsOfMs: 1_000,
    });
    const next = readInsightsReportQuery({
      query: { kind: "bundleSummaries", bundleIds: ["a", "b"], window: "7d" },
      minAsOfMs: 2_000,
    });
    expect(first.semanticKey).toBe(next.semanticKey);
    expect(first.query).toEqual(next.query);
    expect(next.minAsOfMs).toBe(2_000);
    expect(first.query).toMatchObject({ bundleIds: ["a", "b"] });
  });

  it("keeps report families, windows, exact user identity and ID boundaries distinct", () => {
    const queries: InsightsReportQuery[] = [
      { kind: "bundleSummaries", bundleIds: ["a,b"], window: "all" },
      { kind: "bundleSummaries", bundleIds: ["a", "b"], window: "all" },
      { kind: "bundleDetail", bundleId: "a,b", window: "all" },
      { kind: "bundleDetail", bundleId: "a,b", window: "30d" },
      { kind: "installationOverview" },
      { kind: "activeOverview", window: "30d" },
      { kind: "activeOverview", window: "30d", userId: "User" },
      { kind: "activeOverview", window: "30d", userId: "user" },
      { kind: "activeOverview", window: "30d", userId: " User " },
      { kind: "activeOverview", window: "7d", userId: "User" },
    ];
    expect(
      new Set(
        queries.map((query) => readInsightsReportQuery({ query }).semanticKey),
      ).size,
    ).toBe(queries.length);
  });

  it("rejects unsupported filters and excessive batch work instead of silently sharing another report", () => {
    const invalid = [
      null,
      { query: null },
      { query: { kind: "installationOverview", userId: "ignored" } },
      { query: { kind: "activeOverview", window: "all" } },
      { query: { kind: "activeOverview", window: "7d", userId: null } },
      { query: { kind: "activeOverview", window: "7d", userId: "" } },
      { query: { kind: "bundleDetail", bundleId: "b", window: "unknown" } },
      {
        query: {
          kind: "bundleSummaries",
          bundleIds: Array(101).fill("a"),
          window: "all",
        },
      },
      { query: { kind: "bundleSummaries", bundleIds: [""], window: "all" } },
      {
        query: {
          kind: "bundleSummaries",
          bundleIds: ["a".repeat(1_025)],
          window: "all",
        },
      },
      { query: { kind: "installationOverview" }, minAsOfMs: -1 },
      { query: { kind: "installationOverview" }, minAsOfMs: Number.NaN },
      { query: { kind: "installationOverview" }, minAsOfMs: null },
      { query: { kind: "installationOverview" }, asOfMs: 1_000 },
      { query: { kind: "futureReport" } },
      {
        query: { kind: "bundleSummaries", bundleIds: Array(1), window: "all" },
      },
    ];
    for (const input of invalid) {
      expect(() =>
        readInsightsReportQuery(input as InsightsReportInput),
      ).toThrow("invalid-query");
    }
  });
});

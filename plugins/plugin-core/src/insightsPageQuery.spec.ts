import { describe, expect, it } from "vitest";

import {
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
} from "./insightsPageQuery";

describe("Insights page structural readers", () => {
  it("preserves the inclusive event lower bound and canonical selector", () => {
    expect(
      readInsightsPageEventsInput({
        selector: { kind: "installationId", installId: "" },
        sinceReceivedAtMs: 100,
        beforeReceivedAtMs: 100,
        limit: 1,
      }),
    ).toEqual({
      selector: { kind: "installationId", installId: "" },
      sinceReceivedAtMs: 100,
      beforeReceivedAtMs: 100,
      limit: 1,
    });
  });

  it("rejects malformed event structures before storage", () => {
    for (const value of [
      {
        selector: { kind: "all", extra: true },
        beforeReceivedAtMs: 2,
        limit: 1,
      },
      {
        selector: { kind: "bundleId", bundleId: "" },
        beforeReceivedAtMs: 2,
        limit: 1,
      },
      {
        selector: { kind: "all" },
        sinceReceivedAtMs: 3,
        beforeReceivedAtMs: 2,
        limit: 1,
      },
      {
        selector: { kind: "all" },
        beforeReceivedAtMs: 2,
        limit: 101,
      },
    ]) {
      expect(() => readInsightsPageEventsInput(value)).toThrow("invalid-query");
    }
  });

  it("keeps historical strings literal and rejects cursors on exact lookup", () => {
    expect(
      readInsightsInstallationPageInput({
        kind: "contains",
        query: "%_İe\u0301",
        publicationId: "publication-1",
        minAsOfMs: 1,
        limit: 2,
      }),
    ).toEqual({
      kind: "contains",
      query: "%_İe\u0301",
      publicationId: "publication-1",
      minAsOfMs: 1,
      limit: 2,
    });
    expect(() =>
      readInsightsInstallationPageInput({
        kind: "installationId",
        installId: "installation-1",
        limit: 1,
        cursor: "cursor",
      }),
    ).toThrow("invalid-query");
  });

  it("rejects extra fields, empty searches, and U+0000", () => {
    for (const value of [
      { kind: "userId", userId: "", limit: 1 },
      { kind: "contains", query: "", limit: 1 },
      { kind: "all", limit: 1, extra: true },
      { kind: "contains", query: "nul\0query", limit: 1 },
    ]) {
      expect(() => readInsightsInstallationPageInput(value)).toThrow(
        "invalid-query",
      );
    }
  });
});

import { describe, expectTypeOf, it } from "vitest";

import type {
  InsightsLiveInstallationPage,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsInstallationPageInput,
  InsightsPageEventsResult,
  InsightsPublishedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsReportPage,
  InsightsTotal,
} from "./insightsQueries";

describe("required Insights query DTOs", () => {
  it("pins and refreshes publication-backed historical user lookups", () => {
    expectTypeOf<
      Extract<
        InsightsPublishedInstallationPageInput,
        { readonly kind: "userId" }
      >
    >().toMatchTypeOf<{
      readonly kind: "userId";
      readonly userId: string;
      readonly publicationId?: string;
      readonly minAsOfMs?: number;
      readonly limit: number;
      readonly cursor?: string;
    }>();
  });

  it("makes an exact installation lookup a single non-cursor request", () => {
    type ExactInput = Extract<
      InsightsInstallationPageInput,
      { readonly kind: "installationId" }
    >;
    expectTypeOf<ExactInput>().toMatchTypeOf<{
      readonly kind: "installationId";
      readonly installId: string;
      readonly limit: number;
      readonly cursor?: never;
    }>();
    const invalid: ExactInput = {
      kind: "installationId",
      installId: "install-1",
      limit: 1,
      // @ts-expect-error Exact 0/1 lookup cannot accept a continuation.
      cursor: "cursor",
    };
    expectTypeOf(invalid).toEqualTypeOf<ExactInput>();
  });

  it("specializes direct pins and cursor continuations", () => {
    expectTypeOf<InsightsPinnedInstallationPageInput>().toMatchTypeOf<{
      readonly kind: "userId" | "contains";
      readonly publicationId: string;
      readonly cursor?: never;
      readonly limit: number;
    }>();
    expectTypeOf<InsightsPublishedInstallationContinuationInput>().toMatchTypeOf<{
      readonly kind: "userId" | "contains";
      readonly publicationId?: string;
      readonly cursor: string;
      readonly limit: number;
    }>();
  });

  it("excludes stale live reads and preparation from publication pages", () => {
    expectTypeOf<InsightsPageEventsResult["state"]>().toEqualTypeOf<
      "ready" | "preparing" | "failed"
    >();
    expectTypeOf<InsightsLiveInstallationPage["state"]>().toEqualTypeOf<
      "ready" | "preparing" | "failed"
    >();
    expectTypeOf<InsightsReportPage["state"]>().toEqualTypeOf<
      "ready" | "failed" | "expired"
    >();
    expectTypeOf<InsightsPinnedInstallationPage["state"]>().toEqualTypeOf<
      "ready" | "failed" | "expired"
    >();
    expectTypeOf<
      InsightsPublishedInstallationContinuation["state"]
    >().toEqualTypeOf<"ready" | "stale" | "failed" | "expired">();
    expectTypeOf<
      Extract<
        InsightsPageEventsResult,
        { readonly state: "ready" }
      >["versions"]["projectionGeneration"]
    >().toEqualTypeOf<null>();
    expectTypeOf<
      Extract<
        InsightsReportPage,
        { readonly state: "ready" }
      >["versions"]["projectionGeneration"]
    >().toEqualTypeOf<string>();
  });

  it("makes totals explicit and generation-bound", () => {
    expectTypeOf<InsightsTotal>().toEqualTypeOf<
      | {
          readonly state: "exact";
          readonly value: number;
          readonly sourceGeneration: string;
        }
      | { readonly state: "pending"; readonly jobId: string }
      | { readonly state: "unavailable" }
    >();
  });
});

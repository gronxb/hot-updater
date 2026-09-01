import type {
  InsightsInstallationRow,
  InsightsPublication,
  InsightsReportPageInput,
  InsightsReportPublication,
} from "@hot-updater/plugin-core";

interface PageInput {
  readonly limit: number;
  readonly cursor?: string;
}

interface PageRows<TRow> {
  readonly rows: readonly TRow[];
  readonly nextCursor: string | null;
}

export type PostgresInsightsInstallationPageInput = PageInput &
  (
    | { readonly kind: "all" }
    | { readonly kind: "installation"; readonly installId: string }
    | {
        readonly kind: "contains";
        readonly query: string;
        readonly publicationId?: string;
        readonly minAsOfMs?: number;
      }
    | {
        readonly kind: "userId";
        readonly userId: string;
        readonly publicationId?: string;
        readonly minAsOfMs?: number;
      }
  );

export interface PostgresInsightsInstallationPublication extends InsightsPublication {
  readonly total: number;
}

type Unpublished<TPublication> =
  | {
      readonly state: "queued" | "preparing";
      readonly jobId: string;
      readonly sourceGeneration: string;
      readonly previous: TPublication | null;
    }
  | {
      readonly state: "failed";
      readonly error: {
        readonly code: "preparation-failed";
        readonly jobId: string;
      };
      readonly sourceGeneration: string;
      readonly previous: TPublication | null;
    };

export type PostgresInsightsInstallationPage =
  | (PageRows<InsightsInstallationRow> & {
      readonly state: "ready";
      readonly consistency: "live";
      readonly observedAtMs: number;
    })
  | (PageRows<InsightsInstallationRow> & {
      readonly state: "ready";
      readonly consistency: "snapshot";
      readonly publication: PostgresInsightsInstallationPublication;
    })
  | Unpublished<PostgresInsightsInstallationPublication>
  | { readonly state: "expired"; readonly publicationId: string };

export type PostgresInsightsReportResult =
  | { readonly state: "ready"; readonly publication: InsightsReportPublication }
  | Unpublished<InsightsReportPublication>;

type ReadyReportPage = {
  readonly state: "ready";
  readonly publicationId: string;
  readonly total: number;
} & (
  | (PageRows<{ readonly bucketStartMs: number; readonly value: number }> & {
      readonly section: "movementSeries";
      readonly metric: "installed" | "recovered";
    })
  | (PageRows<{ readonly cohort: string; readonly value: number }> & {
      readonly section: "movementCohorts";
      readonly metric: "installed" | "recovered";
    })
  | (PageRows<{
      readonly bundleId: string;
      readonly installations: number;
    }> & { readonly section: "bundleDistribution" })
  | (PageRows<{ readonly bucketStartMs: number; readonly value: number }> & {
      readonly section: "activeSeries";
    })
  | (PageRows<{
      readonly bucketStartMs: number;
      readonly value: number;
      readonly bundleId: string;
    }> & { readonly section: "activeBundleSeries" })
);

export type PostgresInsightsReportPage =
  | ReadyReportPage
  | { readonly state: "expired"; readonly publicationId: string };

export type PostgresInsightsReportPageInput = InsightsReportPageInput;

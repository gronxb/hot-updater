import type {
  ReportingOverview,
  InsightsBundleSelection,
  InsightsScope,
  ActiveInstallationWindow,
  CreateBundleEventRequest,
  CursorPage,
  EventCursorPage,
  EventHistoryRow,
  InstallationHistoryRow,
  InstallationRow,
} from "./domain";

export type InsightsEventPageInput = {
  readonly beforeReceivedAtMs?: number;
  readonly sinceMs?: number;
  readonly bundle?: InsightsBundleSelection;
  readonly cursor?: string;
  readonly limit?: number;
};

export type InsightsInstallationEventPageInput = Omit<
  InsightsEventPageInput,
  "bundle"
> & {
  readonly installId: string;
};

export type InsightsUserInstallationPageInput = {
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type InsightsProvider = {
  appendBundleEvent(input: CreateBundleEventRequest): Promise<void>;
  listEvents(
    input: InsightsEventPageInput,
  ): Promise<EventCursorPage<EventHistoryRow>>;
  listInstallationEvents(
    input: InsightsInstallationEventPageInput,
  ): Promise<EventCursorPage<InstallationHistoryRow>>;
  getInstallation(input: {
    readonly installId: string;
  }): Promise<InstallationRow | null>;
  pageInstallationsByCurrentUserId(
    input: InsightsUserInstallationPageInput,
  ): Promise<CursorPage<InstallationRow>>;
  getReportingOverview(
    input: InsightsScope & {
      readonly window: ActiveInstallationWindow;
      readonly bundleId?: string;
    },
  ): Promise<ReportingOverview>;
};

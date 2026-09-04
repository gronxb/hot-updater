import type {
  ActiveInstallationOverview,
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
  readonly cursor?: string;
  readonly limit?: number;
};

export type InsightsInstallationEventPageInput = InsightsEventPageInput & {
  readonly installId: string;
};

export type InsightsUserInstallationPageInput = {
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type InsightsProvider = {
  appendBundleEvent(input: CreateBundleEventRequest): Promise<void>;
  pageEvents(
    input: InsightsEventPageInput,
  ): Promise<EventCursorPage<EventHistoryRow>>;
  pageInstallationEvents(
    input: InsightsInstallationEventPageInput,
  ): Promise<EventCursorPage<InstallationHistoryRow>>;
  getInstallation(installId: string): Promise<InstallationRow | null>;
  pageInstallationsByCurrentUserId(
    input: InsightsUserInstallationPageInput,
  ): Promise<CursorPage<InstallationRow>>;
  getActiveInstallationOverview(input: {
    readonly window: ActiveInstallationWindow;
  }): Promise<ActiveInstallationOverview>;
};

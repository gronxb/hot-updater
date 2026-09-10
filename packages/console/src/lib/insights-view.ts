import type { EventHistoryRow, InstallationRow } from "@hot-updater/server";

export type InsightsEventRow = EventHistoryRow;
export type InsightsInstallationViewRow = InstallationRow;

export type InsightsViewPage<TRow> = {
  readonly data: readonly TRow[];
  readonly nextCursor: string | null;
};

export const outcomeLabels = {
  downloaded: "Downloaded reports",
  applied: "Applied reports",
  recovered: "Recovered-from reports",
  unchanged: "No-change reports",
} as const;

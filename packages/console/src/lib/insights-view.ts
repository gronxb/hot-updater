import type {
  BundleEventRow,
  InsightsInstallationRow,
  InsightsPageData,
  InsightsTotal,
} from "@hot-updater/plugin-core";

export type InsightsEventRow = {
  readonly id: string;
  readonly installId: string;
  readonly type: BundleEventRow["type"];
  readonly fromBundleId: string | null;
  readonly toBundleId: string;
  readonly username: string | null;
  readonly userId: string | null;
  readonly platform: BundleEventRow["platform"];
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly receivedAtMs: number;
};

export type InsightsInstallationViewRow = Omit<
  InsightsEventRow,
  "fromBundleId" | "installId"
> & {
  readonly installId: string;
  readonly lastKnownBundleId: string;
  readonly latestStatus: BundleEventRow["type"];
};

export type InsightsViewPage<TRow> = {
  readonly data: readonly TRow[];
  readonly hasNext: boolean;
  readonly nextCursor: string | null;
  readonly total: number | null;
};

export const toInsightsEventRow = (row: BundleEventRow): InsightsEventRow => ({
  id: row.id,
  installId: row.install_id,
  type: row.type,
  fromBundleId: row.from_bundle_id,
  toBundleId: row.to_bundle_id,
  username: row.username,
  userId: row.user_id,
  platform: row.platform,
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  receivedAtMs: row.received_at_ms,
});

export const toInsightsInstallationViewRow = (
  row: InsightsInstallationRow,
): InsightsInstallationViewRow => ({
  id: row.id,
  installId: row.install_id,
  lastKnownBundleId: row.to_bundle_id,
  latestStatus: row.type,
  type: row.type,
  toBundleId: row.to_bundle_id,
  username: row.username,
  userId: row.user_id,
  platform: row.platform,
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  receivedAtMs: row.received_at_ms,
});

export const mapInsightsPageData = <TInput, TOutput>(
  page: InsightsPageData<TInput>,
  map: (row: TInput) => TOutput,
): InsightsPageData<TOutput> => ({
  ...page,
  data: page.data.map(map),
});

export const getExactInsightsTotal = (
  total: InsightsTotal,
  sourceGeneration: string,
): number | null =>
  total.state === "exact" && total.sourceGeneration === sourceGeneration
    ? total.value
    : null;

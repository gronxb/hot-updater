import type {
  BundleEventRow,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  emptyInsightsDistinct,
  getInsightsDistinctRegister,
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  insightsOverviewValues,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_V1_TABLE_NAMES } from "./supabaseInfrastructureNames";
import { SupabaseMissingDataError, throwSupabaseError } from "./supabaseResult";
import type { Database, SupabaseInsightsOverviewRow } from "./types";

export const supabaseOverviewPayload = (event: BundleEventRow) => ({
  deltas: insightsOverviewDeltas(event).map((delta) => {
    const launch =
      delta.launchIdentity === undefined
        ? undefined
        : getInsightsDistinctRegister(delta.launchIdentity);
    const activity =
      delta.activityIdentity === undefined
        ? undefined
        : getInsightsDistinctRegister(delta.activityIdentity);
    return {
      ...insightsOverviewValues(delta.identity),
      downloads: delta.downloads,
      launches: delta.launches,
      failed_launches: delta.failedLaunches,
      launch_users:
        delta.launchIdentity === undefined
          ? null
          : addInsightsDistinct(emptyInsightsDistinct(), delta.launchIdentity),
      activity_users:
        delta.activityIdentity === undefined
          ? null
          : addInsightsDistinct(
              emptyInsightsDistinct(),
              delta.activityIdentity,
            ),
      launch_position: launch === undefined ? null : launch.index + 1,
      launch_character: launch?.character ?? null,
      activity_position: activity === undefined ? null : activity.index + 1,
      activity_character: activity?.character ?? null,
    };
  }),
  distribution: insightsOverviewValues(insightsDistributionIdentity(event)),
});

const releaseIdentity = (
  release: ReleaseReference,
  periodKind: "lifetime" | "hour",
  bucketStartMs: number,
): InsightsOverviewIdentity => ({
  scopeKind: "release",
  releaseKind: "specific",
  releaseId: release.releaseId,
  channel: release.channel,
  platform: release.platform,
  appVersionKind: "all",
  appVersion: "",
  periodKind,
  bucketStartMs,
});

const metrics = (
  rows: readonly SupabaseInsightsOverviewRow[],
  withPeriod: boolean,
) => {
  const daily = new Map<number, { launches: number; failedLaunches: number }>();
  for (const value of rows) {
    const start = Math.floor(value.bucket_start_ms / 86_400_000) * 86_400_000;
    const point = daily.get(start) ?? { launches: 0, failedLaunches: 0 };
    point.launches += value.launches;
    point.failedLaunches += value.failed_launches;
    daily.set(start, point);
  }
  return {
    downloads: rows.reduce((sum, value) => sum + value.downloads, 0),
    launches: rows.reduce((sum, value) => sum + value.launches, 0),
    failedLaunches: rows.reduce((sum, value) => sum + value.failed_launches, 0),
    ...(withPeriod
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map((value) => value.launch_users)),
          ),
          series: [...daily]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getSupabaseReleaseActivity = async (
  supabase: SupabaseClient<Database>,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  let query = supabase
    .from(SUPABASE_V1_TABLE_NAMES.insightsOverview)
    .select("*");
  if (input.scope !== undefined) {
    query = query
      .eq("scope_kind", "channel")
      .eq("channel", input.scope.channel)
      .eq("platform", input.scope.platform)
      .eq("period_kind", "hour")
      .gte("bucket_start_ms", input.timeRange.start)
      .lt("bucket_start_ms", input.timeRange.end);
  } else if (input.timeRange === undefined) {
    const ids = input.releases.map((release) =>
      insightsOverviewId(releaseIdentity(release, "lifetime", 0)),
    );
    if (ids.length === 0) {
      return {
        coverage: { kind: "complete", sinceMs: 0 },
        measuredAtMs: Date.now(),
        data: [],
      };
    }
    query = query.in("id", ids);
  } else {
    query = query
      .eq("scope_kind", "release")
      .in(
        "release_id",
        input.releases.map(({ releaseId }) => releaseId),
      )
      .eq("period_kind", "hour")
      .gte("bucket_start_ms", input.timeRange.start)
      .lt("bucket_start_ms", input.timeRange.end);
  }
  query = query.order("bucket_start_ms", { ascending: true });
  const data: SupabaseInsightsOverviewRow[] = [];
  while (true) {
    const result = await query.range(data.length, data.length + 999);
    throwSupabaseError("get release activity", result.error);
    if (result.data === null)
      throw new SupabaseMissingDataError("get release activity");
    if (result.data.length === 0) break;
    data.push(...result.data);
  }
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    measuredAtMs: Date.now(),
    data:
      input.scope !== undefined
        ? [{ scope: input.scope, metrics: metrics(data, true) }]
        : input.releases.map((release) => ({
            release,
            metrics: metrics(
              data.filter(
                (value) =>
                  value.release_id === release.releaseId &&
                  value.channel === release.channel &&
                  value.platform === release.platform,
              ),
              input.timeRange !== undefined,
            ),
          })),
  };
};

export const getSupabaseAppUsage = async (
  supabase: SupabaseClient<Database>,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const usageQuery = supabase
    .from(SUPABASE_V1_TABLE_NAMES.insightsOverview)
    .select("*")
    .eq("scope_kind", "usage")
    .eq("channel", input.channel)
    .eq("platform", input.platform)
    .eq("app_version_kind", input.appVersion === undefined ? "all" : "specific")
    .eq("app_version", input.appVersion ?? "")
    .eq("period_kind", "hour")
    .gte("bucket_start_ms", input.timeRange.start)
    .lt("bucket_start_ms", input.timeRange.end)
    .order("bucket_start_ms", { ascending: true });
  const usage: SupabaseInsightsOverviewRow[] = [];
  while (true) {
    const result = await usageQuery.range(usage.length, usage.length + 999);
    throwSupabaseError("get app usage", result.error);
    if (result.data === null)
      throw new SupabaseMissingDataError("get app usage");
    if (result.data.length === 0) break;
    usage.push(...result.data);
  }
  let distributionQuery = supabase
    .from(SUPABASE_V1_TABLE_NAMES.insightsOverview)
    .select("*")
    .eq("scope_kind", "distribution")
    .eq("channel", input.channel)
    .eq("period_kind", "latest")
    .gte("bucket_start_ms", input.timeRange.start)
    .lt("bucket_start_ms", input.timeRange.end)
    .gt("latest_installations", 0);
  if (input.platform !== "all") {
    distributionQuery = distributionQuery.eq("platform", input.platform);
  }
  if (input.appVersion !== undefined) {
    distributionQuery = distributionQuery.eq("app_version", input.appVersion);
  }
  const distribution: SupabaseInsightsOverviewRow[] = [];
  while (true) {
    const result = await distributionQuery.range(
      distribution.length,
      distribution.length + 999,
    );
    throwSupabaseError("get app distribution", result.error);
    if (result.data === null)
      throw new SupabaseMissingDataError("get app distribution");
    if (result.data.length === 0) break;
    distribution.push(...result.data);
  }
  const points = [];
  for (
    let startMs = input.timeRange.start;
    startMs < input.timeRange.end;
    startMs += input.intervalMs
  ) {
    points.push({
      startMs,
      installations: countInsightsDistinct(
        mergeInsightsDistinct(
          usage
            .filter(
              (value) =>
                value.bucket_start_ms >= startMs &&
                value.bucket_start_ms < startMs + input.intervalMs,
            )
            .map((value) => value.activity_users),
        ),
      ),
    });
  }
  const group = (field: "app_version" | "platform") => {
    const values = new Map<string, number>();
    for (const value of distribution) {
      values.set(
        value[field],
        (values.get(value[field]) ?? 0) + value.latest_installations,
      );
    }
    return [...values]
      .map(([name, installations]) => ({ name, installations }))
      .sort(
        (left, right) =>
          right.installations - left.installations ||
          left.name.localeCompare(right.name, "en", { numeric: true }),
      );
  };
  const bundle = new Map<
    string,
    InsightsGetAppUsageResult["bundleDistribution"][number]
  >();
  for (const value of distribution) {
    const releaseId =
      value.release_kind === "specific" ? value.release_id : null;
    const key = JSON.stringify([value.app_version, value.platform, releaseId]);
    const previous = bundle.get(key);
    bundle.set(key, {
      appVersion: value.app_version,
      platform: value.platform as "ios" | "android",
      releaseId,
      installations:
        (previous?.installations ?? 0) + value.latest_installations,
    });
  }
  const versions = group("app_version");
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map((value) => value.activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundle.values()],
    measuredAtMs: Date.now(),
  };
};

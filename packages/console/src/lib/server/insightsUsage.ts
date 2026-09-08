import type { BundleEventRow, InsightsModel } from "@hot-updater/plugin-core";

import { readRecoveryInput, recoveryWindows } from "../insights-recovery";
import type {
  AppUsageInput,
  AppUsageReport,
  BundleDistribution,
  UsageDistribution,
} from "../insights-usage";
import { readInsightsHistory } from "./insightsHistory";

export async function getAppUsageReport(
  model: InsightsModel,
  input: AppUsageInput,
  beforeReceivedAtMs = Date.now(),
): Promise<AppUsageReport> {
  readRecoveryInput(input);
  const history = await readInsightsHistory(
    model,
    input.window,
    beforeReceivedAtMs,
  );
  const { intervalMs, durationMs } = recoveryWindows[input.window];
  const startMs = Math.max(0, beforeReceivedAtMs - durationMs);
  const bucketStart = (ms: number) => Math.floor(ms / intervalMs) * intervalMs;
  const latest = new Map<string, BundleEventRow>();
  const observed = new Map<string, BundleEventRow>();
  const buckets = new Map<number, Set<string>>();
  const appVersions = new Set<string>();

  for (const event of history.events) {
    const previous = observed.get(event.install_id);
    const row = {
      ...event,
      to_release_id:
        event.to_release_id ??
        (event.type === "UNCHANGED" &&
        previous?.to_bundle_id === event.to_bundle_id &&
        previous.platform === event.platform &&
        previous.channel === event.channel
          ? previous.to_release_id
          : null),
    };
    observed.set(row.install_id, row);
    if (
      row.channel !== input.channel ||
      (input.platform !== "all" && row.platform !== input.platform)
    )
      continue;
    appVersions.add(row.app_version);
    if (input.appVersion !== undefined && row.app_version !== input.appVersion)
      continue;
    latest.set(row.install_id, row);
    const start = bucketStart(row.received_at_ms);
    const installations = buckets.get(start) ?? new Set<string>();
    installations.add(row.install_id);
    buckets.set(start, installations);
  }

  const distribution = (
    field: "app_version" | "platform",
  ): UsageDistribution[] => {
    const counts = new Map<string, number>();
    for (const row of latest.values())
      counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
    return Array.from(counts, ([name, installations]) => ({
      name,
      installations,
    })).sort(
      (a, b) =>
        b.installations - a.installations ||
        a.name.localeCompare(b.name, "en", { numeric: true }),
    );
  };
  const points: AppUsageReport["points"][number][] = [];
  for (
    let start = bucketStart(startMs);
    start < beforeReceivedAtMs;
    start += intervalMs
  ) {
    points.push({
      startMs: start,
      // Missing history is unknown, while a completely read interval with no reports is zero.
      installations:
        start + intervalMs <= history.sinceMs
          ? null
          : (buckets.get(start)?.size ?? 0),
    });
  }
  const bundleCounts = new Map<string, BundleDistribution>();
  for (const row of latest.values()) {
    const key = JSON.stringify([
      row.app_version,
      row.platform,
      row.to_release_id,
    ]);
    bundleCounts.set(key, {
      appVersion: row.app_version,
      platform: row.platform,
      releaseId: row.to_release_id,
      installations: (bundleCounts.get(key)?.installations ?? 0) + 1,
    });
  }
  return {
    bundleDistribution: [...bundleCounts.values()].sort(
      (a, b) =>
        b.appVersion.localeCompare(a.appVersion, "en", { numeric: true }) ||
        b.installations - a.installations ||
        a.platform.localeCompare(b.platform) ||
        (a.releaseId ?? "").localeCompare(b.releaseId ?? ""),
    ),
    activeInstallations: latest.size,
    sinceMs: history.sinceMs,
    beforeReceivedAtMs,
    intervalMs,
    truncated: history.truncated,
    appVersions: [...appVersions].sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    ),
    versions: distribution("app_version"),
    platforms: distribution("platform"),
    points,
  };
}

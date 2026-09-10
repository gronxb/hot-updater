import type { InsightsModel } from "@hot-updater/plugin-core";

import {
  readRecoveryInput,
  type RecoveryInput,
  type RecoveryReport,
  type RecoverySeries,
} from "../insights-recovery";
import { readInsightsHistory, type InsightsHistory } from "./insightsHistory";

export async function getRecoveryReport(
  model: InsightsModel,
  input: RecoveryInput,
  beforeReceivedAtMs = Date.now(),
): Promise<RecoveryReport> {
  readRecoveryInput(input);
  return buildRecoveryReport(
    await readInsightsHistory(model, input.window, beforeReceivedAtMs),
    input,
  );
}

export function buildRecoveryReport(
  history: InsightsHistory,
  input: RecoveryInput,
): RecoveryReport {
  const { events, sinceMs, beforeReceivedAtMs, intervalMs, truncated } =
    history;
  const bucketStart = (time: number) =>
    Math.floor(time / intervalMs) * intervalMs;
  const releases = new Map<
    string,
    {
      firstAppliedAtMs: number | null;
      recovered: Set<string>;
      downloaded: Set<string>;
      buckets: Map<
        number,
        {
          applied: number;
          downloaded: Set<string>;
          recovered: number;
          installations: Set<string>;
          lastRecoveredAtMs: number;
        }
      >;
    }
  >();
  const ensureRelease = (id: string) => {
    let release = releases.get(id);
    if (!release) {
      release = {
        firstAppliedAtMs: null,
        recovered: new Set(),
        downloaded: new Set(),
        buckets: new Map(),
      };
      releases.set(id, release);
    }
    return release;
  };
  const latest = new Map<
    string,
    {
      releaseId: string | null;
      bundleId: string;
      pendingReleaseId: string | null;
      pending: boolean;
      inScope: boolean;
    }
  >();
  const downloadedInstallations = new Set<string>();
  const active = new Map<string, number>();
  const pending = new Map<string, number>();
  const pendingSnapshots = new Map<number, Map<string, number> | null>();
  const snapshots = new Map<number, Map<string, number> | null>();
  let unattributedInstallations = 0;
  let observed = false;
  let eventIndex = 0;
  for (
    let startMs = bucketStart(sinceMs);
    startMs < beforeReceivedAtMs;
    startMs += intervalMs
  ) {
    while (
      eventIndex < events.length &&
      events[eventIndex].received_at_ms < startMs + intervalMs
    ) {
      const row = events[eventIndex++];
      const inScope =
        (input.platform === "all" || row.platform === input.platform) &&
        row.channel === input.channel &&
        (input.appVersion === undefined ||
          row.app_version === input.appVersion);
      const previous = latest.get(row.install_id);
      // Lifecycle reports can omit the ID on UNCHANGED. Only retain an observed ID for the same file and scope.
      const downloaded = row.type === "UPDATE_DOWNLOADED";
      const currentBundleId = downloaded
        ? row.from_bundle_id
        : row.to_bundle_id;
      const releaseId =
        (downloaded ? row.from_release_id : row.to_release_id) ??
        ((row.type === "UNCHANGED" || downloaded) &&
        previous?.bundleId === currentBundleId &&
        previous.inScope === inScope
          ? previous.releaseId
          : null);
      if (previous?.inScope) {
        if (previous.pendingReleaseId) {
          pending.set(
            previous.pendingReleaseId,
            (pending.get(previous.pendingReleaseId) ?? 0) - 1,
          );
        }
        if (previous.releaseId)
          active.set(
            previous.releaseId,
            (active.get(previous.releaseId) ?? 0) - 1,
          );
        else unattributedInstallations -= 1;
      }
      latest.set(row.install_id, {
        releaseId,
        bundleId: currentBundleId,
        pendingReleaseId: downloaded ? row.to_release_id : null,
        pending: downloaded,
        inScope,
      });
      if (!inScope) continue;
      observed = true;
      if (
        downloaded &&
        (!input.releaseId || row.to_release_id === input.releaseId)
      )
        downloadedInstallations.add(row.install_id);
      if (downloaded && row.to_release_id) {
        ensureRelease(row.to_release_id).downloaded.add(row.install_id);
        pending.set(
          row.to_release_id,
          (pending.get(row.to_release_id) ?? 0) + 1,
        );
      }
      if (releaseId) {
        ensureRelease(releaseId);
        active.set(releaseId, (active.get(releaseId) ?? 0) + 1);
      } else unattributedInstallations += 1;
      if (row.from_release_id) ensureRelease(row.from_release_id);
      const outcomeId =
        row.type === "RECOVERED" ? row.from_release_id : row.to_release_id;
      if (
        !outcomeId ||
        (row.type !== "RECOVERED" &&
          row.type !== "UPDATE_APPLIED" &&
          !downloaded)
      )
        continue;
      const release = ensureRelease(outcomeId);
      const bucket = release.buckets.get(startMs) ?? {
        applied: 0,
        downloaded: new Set<string>(),
        recovered: 0,
        installations: new Set<string>(),
        lastRecoveredAtMs: -1,
      };
      if (downloaded) {
        bucket.downloaded.add(row.install_id);
      } else if (row.type === "RECOVERED") {
        bucket.recovered += 1;
        bucket.installations.add(row.install_id);
        bucket.lastRecoveredAtMs = row.received_at_ms;
        release.recovered.add(row.install_id);
      } else {
        bucket.applied += 1;
        release.firstAppliedAtMs ??= row.received_at_ms;
      }
      release.buckets.set(startMs, bucket);
    }
    // Before the first report there is no observed installation state to chart.
    snapshots.set(startMs, observed ? new Map(active) : null);
    pendingSnapshots.set(startMs, observed ? new Map(pending) : null);
  }
  const series: RecoverySeries[] = [];
  for (const [releaseId, release] of releases) {
    if (input.releaseId && input.releaseId !== releaseId) continue;
    let previousRate: number | null = null;
    const points = Array.from(snapshots, ([startMs, snapshot]) => {
      const bucket = release.buckets.get(startMs);
      const applied = bucket?.applied ?? 0;
      const recovered = bucket?.recovered ?? 0;
      const total = applied + recovered;
      const rate = total === 0 ? null : (recovered / total) * 100;
      const spike =
        release.firstAppliedAtMs !== null &&
        (bucket?.lastRecoveredAtMs ?? -1) >= release.firstAppliedAtMs &&
        (!truncated || previousRate !== null) &&
        rate !== null &&
        total >= 10 &&
        recovered >= 3 &&
        rate >= 10 &&
        rate - (previousRate ?? 0) >= 10;
      if (rate !== null) previousRate = rate;
      return {
        startMs,
        active: snapshot ? (snapshot.get(releaseId) ?? 0) : null,
        pendingInstallations: snapshot
          ? (pendingSnapshots.get(startMs)?.get(releaseId) ?? 0)
          : null,
        downloadedInstallations: bucket?.downloaded.size ?? 0,
        recoveredInstallations: bucket?.installations.size ?? 0,
        applied,
        recovered,
        rate,
        spike,
      };
    });
    series.push({
      releaseId,
      firstAppliedAtMs: release.firstAppliedAtMs,
      activeInstallations: active.get(releaseId) ?? 0,
      pendingInstallations: pending.get(releaseId) ?? 0,
      downloadedInstallations: release.downloaded.size,
      recoveredInstallations: release.recovered.size,
      points,
    });
  }
  series.sort((a, b) => b.releaseId.localeCompare(a.releaseId));
  return {
    sinceMs,
    beforeReceivedAtMs,
    intervalMs,
    truncated,
    unattributedInstallations,
    downloadedInstallations: downloadedInstallations.size,
    pendingInstallations: Array.from(latest.values()).filter(
      (row) =>
        row.inScope &&
        row.pending &&
        (!input.releaseId || row.pendingReleaseId === input.releaseId),
    ).length,
    series,
  };
}

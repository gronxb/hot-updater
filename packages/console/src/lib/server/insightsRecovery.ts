import type {
  DatabaseModels,
  ReleaseActivity,
  ReleaseReference,
} from "@hot-updater/plugin-core";

import {
  readRecoveryInput,
  recoveryWindows,
  type RecoveryInput,
  type RecoveryReport,
  type RecoverySeries,
} from "../insights-recovery";

export async function getAggregatedRecoveryReport(
  models: Pick<DatabaseModels, "channels" | "releases" | "insights">,
  input: RecoveryInput,
  now = Date.now(),
): Promise<RecoveryReport> {
  readRecoveryInput(input);
  const channel = (await models.channels.list({})).channels.find(
    (candidate) => candidate.name === input.channel,
  );
  if (!channel) throw new Error("Choose an existing channel.");

  const platforms =
    input.platform === "all" ? (["ios", "android"] as const) : [input.platform];
  const releases = (
    await Promise.all(
      platforms.map((platform) =>
        models.releases.findMany({
          channelId: channel.id,
          platform,
          limit: 20,
        }),
      ),
    )
  )
    .flat()
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, 20);
  const availableReferences: ReleaseReference[] = releases.map((release) => ({
    releaseId: release.id,
    platform: release.platform,
    channel: input.channel,
  }));
  let selected = input.releaseId
    ? availableReferences.find(({ releaseId }) => releaseId === input.releaseId)
    : availableReferences[0];
  if (input.releaseId && !selected) {
    const release = await models.releases.findById(input.releaseId);
    if (
      release &&
      release.channel_id === channel.id &&
      (input.platform === "all" || release.platform === input.platform)
    ) {
      selected = {
        releaseId: release.id,
        platform: release.platform,
        channel: input.channel,
      };
      availableReferences.unshift(selected);
      availableReferences.splice(20);
    }
  }
  const references = selected ? [selected] : [];
  const availableReleaseIds = availableReferences.map(
    ({ releaseId }) => releaseId,
  );

  const { durationMs, intervalMs } = recoveryWindows[input.window];
  const end = Math.ceil(now / 3_600_000) * 3_600_000;
  const sinceMs = end - durationMs;
  if (references.length === 0) {
    return {
      sinceMs,
      beforeReceivedAtMs: end,
      intervalMs,
      truncated: false,
      unattributedInstallations: 0,
      pendingInstallations: 0,
      downloadedInstallations: 0,
      availableReleaseIds,
      series: [],
    };
  }

  const activity = await models.insights.getReleaseActivity({
    releases: references,
    timeRange: { start: sinceMs, end },
  });
  const coverageStart =
    activity.coverage.sinceMs === null
      ? null
      : Math.max(
          sinceMs,
          Math.ceil(activity.coverage.sinceMs / 3_600_000) * 3_600_000,
        );
  const toSeries = (item: ReleaseActivity): RecoverySeries => {
    const hourly = new Map(item.series?.map((point) => [point.startMs, point]));
    const points = [];
    const firstStartMs = Math.floor(sinceMs / intervalMs) * intervalMs;
    for (let startMs = firstStartMs; startMs < end; startMs += intervalMs) {
      let downloaded = 0;
      let applied = 0;
      let recovered = 0;
      let observed = false;
      for (let hour = startMs; hour < startMs + intervalMs; hour += 3_600_000) {
        const point = hourly.get(hour);
        observed ||= point !== undefined;
        downloaded += point?.downloadedReports ?? 0;
        applied += point?.appliedReports ?? 0;
        recovered += point?.recoveredReports ?? 0;
      }
      const known = coverageStart !== null && startMs >= coverageStart;
      const total = applied + recovered;
      const endMs = Math.min(startMs + intervalMs, end, now);
      points.push({
        startMs,
        rangeStartMs: Math.max(startMs, sinceMs),
        endMs,
        partial:
          startMs < sinceMs ||
          startMs + intervalMs > now ||
          (activity.coverage.kind === "partial" &&
            (coverageStart === null || startMs < coverageStart)),
        active: null,
        pendingInstallations: null,
        downloadedInstallations: known || observed ? downloaded : null,
        recoveredInstallations: known || observed ? recovered : null,
        applied: known || observed ? applied : null,
        recovered: known || observed ? recovered : null,
        rate:
          !known && !observed
            ? null
            : total === 0
              ? null
              : (recovered / total) * 100,
        spike: false,
      });
    }
    return {
      releaseId: item.release.releaseId,
      firstAppliedAtMs: null,
      ...item.summary,
      points,
    };
  };
  const series = activity.data.map(toSeries);
  return {
    sinceMs,
    beforeReceivedAtMs: end,
    intervalMs,
    truncated: activity.coverage.kind === "partial",
    unattributedInstallations: 0,
    pendingInstallations: series.reduce(
      (sum, item) => sum + item.pendingInstallations,
      0,
    ),
    downloadedInstallations: series.reduce(
      (sum, item) => sum + item.downloadedInstallations,
      0,
    ),
    availableReleaseIds,
    series,
  };
}

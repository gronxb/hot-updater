import type {
  InsightsEventCursor,
  InsightsModel,
} from "@hot-updater/plugin-core";

import {
  readRecoveryInput,
  recoveryWindows,
  type RecoveryInput,
  type RecoveryReport,
  type RecoverySeries,
} from "../insights-recovery";

const MAX_SCAN_ROWS = 50_000;

export async function getRecoveryReport(
  model: InsightsModel,
  input: RecoveryInput,
  beforeReceivedAtMs = Date.now(),
): Promise<RecoveryReport> {
  readRecoveryInput(input);
  const { durationMs, intervalMs } = recoveryWindows[input.window];
  const sinceMs = Math.max(0, beforeReceivedAtMs - durationMs);
  const bucketStart = (time: number) =>
    Math.floor(time / intervalMs) * intervalMs;
  const releases = new Map<
    string,
    {
      firstAdoptedAtMs: number | null;
      buckets: Map<
        number,
        { adopted: number; recovered: number; lastRecoveredAtMs: number }
      >;
    }
  >();
  const adoptionTotals = new Map<number, number>();
  let after: InsightsEventCursor | undefined;
  let scanned = 0;
  let truncated = false;
  let completeSinceMs = sinceMs;

  while (scanned < MAX_SCAN_ROWS) {
    // Keep the existing bounded scan; native adapters own cursor pagination.
    const limit = Math.min(100, MAX_SCAN_ROWS - scanned);
    const rows = await model.listEvents({
      filter: { kind: "all" },
      sinceMs,
      beforeReceivedAtMs,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    for (const row of page) {
      if (row.platform !== input.platform || row.channel !== input.channel)
        continue;
      if (row.type !== "RECOVERED" && row.type !== "RELEASE_ADOPTED") continue;
      const releaseId =
        row.type === "RECOVERED" ? row.from_release_id : row.to_release_id;
      // Legacy reports without an ID cannot be attributed to a deployment.
      if (!releaseId) continue;
      const startMs = bucketStart(row.received_at_ms);
      if (row.type === "RELEASE_ADOPTED") {
        adoptionTotals.set(startMs, (adoptionTotals.get(startMs) ?? 0) + 1);
      }
      if (input.releaseId && releaseId !== input.releaseId) continue;
      let release = releases.get(releaseId);
      if (!release) {
        release = { firstAdoptedAtMs: null, buckets: new Map() };
        releases.set(releaseId, release);
      }
      const bucket = release.buckets.get(startMs) ?? {
        adopted: 0,
        recovered: 0,
        lastRecoveredAtMs: -1,
      };
      if (row.type === "RECOVERED") {
        bucket.recovered += 1;
        bucket.lastRecoveredAtMs = Math.max(
          bucket.lastRecoveredAtMs,
          row.received_at_ms,
        );
      } else {
        bucket.adopted += 1;
        release.firstAdoptedAtMs = Math.min(
          release.firstAdoptedAtMs ?? Infinity,
          row.received_at_ms,
        );
      }
      release.buckets.set(startMs, bucket);
    }
    scanned += page.length;
    const last = page.at(-1);
    if (!last || rows.length <= limit) break;
    after = { id: last.id, receivedAtMs: last.received_at_ms };
    if (scanned === MAX_SCAN_ROWS) {
      truncated = true;
      // The boundary bucket may contain an incomplete denominator. Omit it.
      completeSinceMs = bucketStart(last.received_at_ms) + intervalMs;
    }
  }

  const series: RecoverySeries[] = [];
  for (const [releaseId, release] of releases) {
    const firstAdoptedAtMs =
      release.firstAdoptedAtMs !== null &&
      release.firstAdoptedAtMs >= completeSinceMs
        ? release.firstAdoptedAtMs
        : null;
    const points = [];
    let previousRate: number | null = null;
    for (
      let startMs = bucketStart(completeSinceMs);
      startMs < beforeReceivedAtMs;
      startMs += intervalMs
    ) {
      const {
        adopted = 0,
        recovered = 0,
        lastRecoveredAtMs = -1,
      } = release.buckets.get(startMs) ?? {};
      const total = adopted + recovered;
      const totalAdopted = adoptionTotals.get(startMs) ?? 0;
      const adoptionShare =
        totalAdopted === 0 ? null : (adopted / totalAdopted) * 100;
      const rate = total === 0 ? null : (recovered / total) * 100;
      const afterAdoption =
        firstAdoptedAtMs !== null && lastRecoveredAtMs >= firstAdoptedAtMs;
      const spike =
        afterAdoption &&
        (!truncated || previousRate !== null) &&
        rate !== null &&
        total >= 10 &&
        recovered >= 3 &&
        rate >= 10 &&
        rate - (previousRate ?? 0) >= 10;
      points.push({ startMs, adopted, adoptionShare, recovered, rate, spike });
      if (rate !== null) previousRate = rate;
    }
    if (points.some(({ rate }) => rate !== null))
      series.push({ releaseId, firstAdoptedAtMs, points });
  }
  // Surface the most recent rollback signal first, then the newest ID.
  series.sort((a, b) => {
    const latestSpike = (s: RecoverySeries) =>
      [...s.points].reverse().find((p) => p.spike)?.startMs ?? -1;
    return (
      latestSpike(b) - latestSpike(a) || b.releaseId.localeCompare(a.releaseId)
    );
  });
  return {
    sinceMs: completeSinceMs,
    beforeReceivedAtMs,
    intervalMs,
    truncated,
    series,
  };
}

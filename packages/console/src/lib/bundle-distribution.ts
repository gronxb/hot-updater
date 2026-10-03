import type { InsightsGetDistributionHistoryResult } from "@hot-updater/server/plugins/insights";

type Observation =
  InsightsGetDistributionHistoryResult["points"][number]["bundles"][number];
const identity = (row: Observation) => row.releaseId ?? row.bundleKind;
const label = (id: string) =>
  id === "builtin"
    ? "Built-in"
    : id === "unknown"
      ? "Unknown bundle"
      : id === "other"
        ? "Other bundles"
        : `${id.slice(0, 8)}…${id.slice(-4)}`;

/** Keep the same series across every day; filtering never changes a day's denominator. */
export function bundleDistributionChart(
  history: InsightsGetDistributionHistoryResult,
  appVersion?: string,
  releaseId?: string,
) {
  const totals = new Map<string, number>();
  const points = history.points.map((point) => {
    const counts = new Map<string, number>();
    for (const row of point.bundles) {
      if (appVersion !== undefined && row.appVersion !== appVersion) continue;
      const id = identity(row);
      counts.set(id, (counts.get(id) ?? 0) + row.installations);
      totals.set(id, (totals.get(id) ?? 0) + row.installations);
    }
    return {
      startMs: point.startMs,
      counts,
      total: [...counts.values()].reduce((a, b) => a + b, 0),
    };
  });
  const releases = [...totals.keys()].filter(
    (id) => id !== "builtin" && id !== "unknown",
  );
  // Release IDs are UUIDv7: include the newest observed release even at low share.
  const newest = [...releases].sort().at(-1);
  const ranked = releases.sort(
    (a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b),
  );
  const visible = releaseId
    ? [releaseId]
    : [...new Set([...(newest ? [newest] : []), ...ranked])].slice(0, 4);
  if (!releaseId)
    for (const id of ["builtin", "unknown"])
      if (totals.has(id)) visible.push(id);
  if ([...totals.keys()].some((id) => !visible.includes(id)))
    visible.push("other");
  const series = visible.map((id, index) => ({
    id,
    key: `bundle${index}`,
    label: label(id),
  }));
  return {
    series,
    points: points.map(({ startMs, counts, total }) => {
      const installations: Record<string, number> = {};
      const shares: Record<string, number | null> = {};
      for (const item of series) {
        const count =
          item.id === "other"
            ? [...counts].reduce(
                (sum, [id, value]) => sum + (visible.includes(id) ? 0 : value),
                0,
              )
            : (counts.get(item.id) ?? 0);
        installations[item.key] = count;
        shares[item.key] = total === 0 ? null : (count / total) * 100;
      }
      return { startMs, total, installations, ...shares } as {
        startMs: number;
        total: number;
        installations: Record<string, number>;
        [key: string]: number | null | Record<string, number>;
      };
    }),
  };
}

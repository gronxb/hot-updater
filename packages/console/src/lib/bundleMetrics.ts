import type { Bundle } from "@hot-updater/plugin-core";

export type ConsoleBundleMetrics = {
  readonly active: number;
  readonly recovered: number;
  readonly lastSeenAt?: string | null;
};

export type BundleWithMetrics = Bundle & {
  readonly metrics?: ConsoleBundleMetrics;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function getBundleMetrics(
  bundle: Bundle,
): ConsoleBundleMetrics | undefined {
  const metrics = (bundle as { readonly metrics?: unknown }).metrics;

  if (
    !isRecord(metrics) ||
    !isNonNegativeInteger(metrics.active) ||
    !isNonNegativeInteger(metrics.recovered)
  ) {
    return undefined;
  }

  const lastSeenAt =
    typeof metrics.lastSeenAt === "string" || metrics.lastSeenAt === null
      ? metrics.lastSeenAt
      : undefined;

  return {
    active: metrics.active,
    recovered: metrics.recovered,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
}

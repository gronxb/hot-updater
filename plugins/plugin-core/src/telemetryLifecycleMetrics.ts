import type {
  Platform,
  TelemetryLifecycleMetrics,
  TelemetryLifecycleMetricsBundle,
  TelemetryLifecycleMetricsPoint,
  TelemetryLifecyclePayload,
} from "./types";

export type TelemetryAnalyticsEventRow = {
  readonly eventType: string;
  readonly id: string;
  readonly observedAt: string;
  readonly payload: TelemetryLifecyclePayload | string | unknown;
  readonly receivedAt: string;
};

const READY_EVENT_TYPE = "app.ready";
const RECOVERED_EVENT_TYPE = "app.recovered";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPayload = (value: unknown): TelemetryLifecyclePayload | null => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isRecord(parsed)) return null;

  const status = parsed.status;
  const platform = parsed.platform;
  if (
    (status !== "ACTIVE" && status !== "RECOVERED") ||
    (platform !== "ios" && platform !== "android")
  ) {
    return null;
  }

  const bundleId = parsed.bundleId;
  const channel = parsed.channel;
  const eventId = parsed.eventId;
  const installId = parsed.installId;
  if (
    typeof bundleId !== "string" ||
    typeof channel !== "string" ||
    typeof eventId !== "string" ||
    typeof installId !== "string"
  ) {
    return null;
  }

  const crashedBundleId =
    typeof parsed.crashedBundleId === "string"
      ? parsed.crashedBundleId
      : undefined;
  const observedAt =
    typeof parsed.observedAt === "string" ? parsed.observedAt : undefined;

  return {
    bundleId,
    channel,
    ...(crashedBundleId === undefined ? {} : { crashedBundleId }),
    eventId,
    installId,
    ...(observedAt === undefined ? {} : { observedAt }),
    platform,
    status,
  };
};

const normalizeObservedAt = (observedAt: string): string =>
  new Date(observedAt).toISOString();

const bucketStartFor = (observedAt: string): string => {
  const bucketStart = new Date(observedAt);
  bucketStart.setUTCMinutes(0, 0, 0);
  return bucketStart.toISOString();
};

const compareEvents = (
  left: TelemetryAnalyticsEventRow,
  right: TelemetryAnalyticsEventRow,
) =>
  left.observedAt.localeCompare(right.observedAt) ||
  left.receivedAt.localeCompare(right.receivedAt) ||
  left.id.localeCompare(right.id);

const eventTypeFor = (payload: TelemetryLifecyclePayload): string =>
  payload.status === "RECOVERED" ? RECOVERED_EVENT_TYPE : READY_EVENT_TYPE;

export const createTelemetryAnalyticsEvent = (
  payload: TelemetryLifecyclePayload,
  receivedAt = new Date().toISOString(),
): TelemetryAnalyticsEventRow => {
  const observedAt = normalizeObservedAt(payload.observedAt ?? receivedAt);
  return {
    eventType: eventTypeFor(payload),
    id: payload.eventId,
    observedAt,
    payload: {
      ...payload,
      observedAt,
    },
    receivedAt,
  };
};

export const deriveTelemetryLifecycleMetrics = (
  rows: readonly TelemetryAnalyticsEventRow[],
): TelemetryLifecycleMetrics => {
  const activeByInstall = new Map<string, TelemetryLifecyclePayload>();
  const recoveredByBundle = new Map<string, number>();
  const bundleMeta = new Map<
    string,
    {
      channel?: string;
      lastSeenAt: string | null;
      platform?: Platform;
    }
  >();
  const seriesByBucket = new Map<string, TelemetryLifecycleMetricsPoint>();

  const touchBundle = (
    bundleId: string,
    payload: TelemetryLifecyclePayload,
    observedAt: string,
  ) => {
    const current = bundleMeta.get(bundleId);
    bundleMeta.set(bundleId, {
      channel: payload.channel,
      lastSeenAt:
        current?.lastSeenAt && current.lastSeenAt > observedAt
          ? current.lastSeenAt
          : observedAt,
      platform: payload.platform,
    });
  };

  const addSeries = (
    bundleId: string,
    observedAt: string,
    delta: { readonly active: number; readonly recovered: number },
  ) => {
    const bucketStart = bucketStartFor(observedAt);
    const key = `${bundleId}:${bucketStart}`;
    const current = seriesByBucket.get(key);
    seriesByBucket.set(key, {
      active: (current?.active ?? 0) + delta.active,
      bucketStart,
      bundleId,
      recovered: (current?.recovered ?? 0) + delta.recovered,
    });
  };

  for (const row of [...rows].sort(compareEvents)) {
    let payload: TelemetryLifecyclePayload | null = null;
    try {
      payload = readPayload(row.payload);
    } catch {
      payload = null;
    }
    if (!payload) continue;

    const observedAt = normalizeObservedAt(
      payload.observedAt ?? row.observedAt,
    );
    activeByInstall.set(payload.installId, payload);
    touchBundle(payload.bundleId, payload, observedAt);
    addSeries(payload.bundleId, observedAt, { active: 1, recovered: 0 });

    if (payload.status === "RECOVERED" && payload.crashedBundleId) {
      recoveredByBundle.set(
        payload.crashedBundleId,
        (recoveredByBundle.get(payload.crashedBundleId) ?? 0) + 1,
      );
      touchBundle(payload.crashedBundleId, payload, observedAt);
      addSeries(payload.crashedBundleId, observedAt, {
        active: 0,
        recovered: 1,
      });
    }
  }

  const activeByBundle = new Map<string, number>();
  for (const payload of activeByInstall.values()) {
    activeByBundle.set(
      payload.bundleId,
      (activeByBundle.get(payload.bundleId) ?? 0) + 1,
    );
  }

  const bundleIds = new Set([
    ...bundleMeta.keys(),
    ...activeByBundle.keys(),
    ...recoveredByBundle.keys(),
  ]);
  const bundles: TelemetryLifecycleMetricsBundle[] = [...bundleIds]
    .map((bundleId) => {
      const meta = bundleMeta.get(bundleId);
      return {
        active: activeByBundle.get(bundleId) ?? 0,
        bundleId,
        ...(meta?.channel === undefined ? {} : { channel: meta.channel }),
        lastSeenAt: meta?.lastSeenAt ?? null,
        ...(meta?.platform === undefined ? {} : { platform: meta.platform }),
        recovered: recoveredByBundle.get(bundleId) ?? 0,
      };
    })
    .sort((left, right) => left.bundleId.localeCompare(right.bundleId));
  const series = [...seriesByBucket.values()].sort(
    (left, right) =>
      left.bucketStart.localeCompare(right.bucketStart) ||
      left.bundleId.localeCompare(right.bundleId),
  );
  const totals = bundles.reduce(
    (nextTotals, bundle) => ({
      active: nextTotals.active + bundle.active,
      recovered: nextTotals.recovered + bundle.recovered,
    }),
    { active: 0, recovered: 0 },
  );

  return { bundles, series, totals };
};

import { NIL_UUID } from "@hot-updater/core";
import {
  type Bundle,
  calculatePagination,
  createTelemetryAnalyticsEvent,
  deriveTelemetryLifecycleMetrics,
  createDatabasePlugin,
  type DatabaseBundleQueryOrder,
  type DatabaseBundleQueryWhere,
  type TelemetryAnalyticsEventRow,
  type TelemetryKeyCredential,
  type TelemetryLifecyclePayload,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";

import { minMax, sleep } from "./util/utils";

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  if (!orderBy) {
    return bundles;
  }

  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const paginateMockBundles = ({
  bundles,
  limit,
  offset,
  cursor,
  orderBy,
}: {
  bundles: Bundle[];
  limit: number;
  offset?: number;
  cursor?: { after?: string; before?: string };
  orderBy?: DatabaseBundleQueryOrder;
}) => {
  const sortedBundles = sortBundles(bundles, orderBy);
  const direction = orderBy?.direction ?? "desc";
  const total = sortedBundles.length;

  if (offset !== undefined) {
    const normalizedOffset = Math.max(0, offset);
    const data =
      limit > 0
        ? sortedBundles.slice(normalizedOffset, normalizedOffset + limit)
        : sortedBundles.slice(normalizedOffset);
    const pagination = calculatePagination(total, {
      limit,
      offset: normalizedOffset,
    });

    return {
      data,
      pagination: {
        ...pagination,
        ...(data.length > 0 && normalizedOffset + data.length < total
          ? { nextCursor: data.at(-1)?.id }
          : {}),
        ...(data.length > 0 && normalizedOffset > 0
          ? { previousCursor: data[0]?.id }
          : {}),
      },
    };
  }

  let data: Bundle[];
  if (cursor?.after) {
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(cursor.after!) < 0
        : bundle.id.localeCompare(cursor.after!) > 0,
    );
    data = limit > 0 ? candidates.slice(0, limit) : candidates;
  } else if (cursor?.before) {
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(cursor.before!) > 0
        : bundle.id.localeCompare(cursor.before!) < 0,
    );
    data =
      limit > 0
        ? candidates.slice(Math.max(0, candidates.length - limit))
        : candidates;
  } else {
    data = limit > 0 ? sortedBundles.slice(0, limit) : sortedBundles;
  }

  const startIndex =
    data.length > 0
      ? sortedBundles.findIndex((bundle) => bundle.id === data[0]!.id)
      : cursor?.after
        ? total
        : 0;
  const pagination = calculatePagination(total, { limit, offset: startIndex });

  return {
    data,
    pagination: {
      ...pagination,
      ...(data.length > 0 && startIndex + data.length < total
        ? { nextCursor: data.at(-1)?.id }
        : {}),
      ...(data.length > 0 && startIndex > 0
        ? { previousCursor: data[0]?.id }
        : {}),
      ...(data.length === 0 && cursor?.after
        ? { previousCursor: cursor.after }
        : {}),
      ...(data.length === 0 && cursor?.before
        ? { nextCursor: cursor.before }
        : {}),
    },
  };
};

const MOCK_INGEST_KEY_CREDENTIAL = {
  active: true,
  keyHash: "64fb1a535afe989701f1c21309df5022bf734fc93730711fb8e25c64bce7e0ea",
  telemetryKeySuffix: "00000000",
} satisfies TelemetryKeyCredential;

const createMockLifecycleEvents = (
  bundles: readonly Bundle[],
): TelemetryAnalyticsEventRow[] =>
  bundles.slice(0, 12).flatMap((bundle, bundleIndex) => {
    const activeCount = Math.max(
      1,
      Math.min(5, Math.ceil((bundle.rolloutCohortCount ?? 1000) / 250)),
    );
    const observedHour = String(8 + (bundleIndex % 8)).padStart(2, "0");
    const activeEvents = Array.from({ length: activeCount }, (_, index) =>
      createTelemetryAnalyticsEvent({
        bundleId: bundle.id,
        channel: bundle.channel,
        eventId: `mock-active-${bundle.id}-${index}`,
        installId: `mock-install-${bundle.id}-${index}`,
        observedAt: `2026-06-28T${observedHour}:00:00.000Z`,
        platform: bundle.platform,
        status: "ACTIVE",
      } satisfies TelemetryLifecyclePayload),
    );

    if (bundleIndex % 3 !== 0) {
      return activeEvents;
    }

    return [
      ...activeEvents,
      createTelemetryAnalyticsEvent({
        bundleId: bundle.id,
        channel: bundle.channel,
        crashedBundleId: bundle.id,
        eventId: `mock-recovered-${bundle.id}`,
        installId: `mock-recovery-install-${bundle.id}`,
        observedAt: `2026-06-28T${observedHour}:30:00.000Z`,
        platform: bundle.platform,
        status: "RECOVERED",
      } satisfies TelemetryLifecyclePayload),
    ];
  });

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createDatabasePlugin<MockDatabaseConfig>({
  name: "mockDatabase",
  analytics: true,
  factory: (config) => {
    const bundles: Bundle[] = config.initialBundles ?? [];
    let ingestKeyCredential: TelemetryKeyCredential | null = {
      ...MOCK_INGEST_KEY_CREDENTIAL,
    };
    const analyticsEvents = createMockLifecycleEvents(bundles);

    return {
      analytics: {
        async getTelemetryKeyCredential() {
          await sleep(minMax(config.latency.min, config.latency.max));
          return ingestKeyCredential;
        },
        async upsertTelemetryKeyCredential(credential) {
          await sleep(minMax(config.latency.min, config.latency.max));
          ingestKeyCredential = credential;
        },
        async setTelemetryKeyActive(active) {
          await sleep(minMax(config.latency.min, config.latency.max));
          if (!ingestKeyCredential) {
            return;
          }
          ingestKeyCredential = {
            ...ingestKeyCredential,
            active,
          };
        },
        async insertLifecycleEvent(payload) {
          await sleep(minMax(config.latency.min, config.latency.max));
          if (analyticsEvents.some((event) => event.id === payload.eventId)) {
            return { accepted: true, deduped: true };
          }
          analyticsEvents.push(createTelemetryAnalyticsEvent(payload));
          return { accepted: true, deduped: false };
        },
        async getLifecycleMetrics() {
          await sleep(minMax(config.latency.min, config.latency.max));
          return deriveTelemetryLifecycleMetrics(analyticsEvents);
        },
      },
      bundles: {
        async get(_context, { id: bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return bundles.find((b) => b.id === bundleId) ?? null;
        },

        async list(_context, options) {
          const { where, limit, offset, cursor, orderBy } = options ?? {};
          await sleep(minMax(config.latency.min, config.latency.max));

          const filteredBundles = sortBundles(
            bundles.filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
            orderBy,
          );

          return {
            ...paginateMockBundles({
              bundles: filteredBundles,
              limit,
              offset,
              cursor,
              orderBy,
            }),
          };
        },
      },
      updates: {
        async check(context, args) {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const targetAppVersions = Array.from(
              new Set(
                bundles
                  .filter(
                    (bundle) =>
                      bundle.enabled &&
                      bundle.platform === args.platform &&
                      bundle.channel === channel &&
                      bundle.id.localeCompare(minBundleId) >= 0 &&
                      bundle.targetAppVersion,
                  )
                  .map((bundle) => bundle.targetAppVersion)
                  .filter((version): version is string => Boolean(version)),
              ),
            );
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const updateBundles = bundles.filter(
              (bundle) =>
                bundle.enabled &&
                bundle.platform === args.platform &&
                bundle.channel === channel &&
                bundle.id.localeCompare(minBundleId) >= 0 &&
                compatibleAppVersions.includes(bundle.targetAppVersion ?? ""),
            );

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: updateBundles,
              context,
            });
          }

          const updateBundles = bundles.filter(
            (bundle) =>
              bundle.enabled &&
              bundle.platform === args.platform &&
              bundle.channel === channel &&
              bundle.id.localeCompare(minBundleId) >= 0 &&
              bundle.fingerprintHash === args.fingerprintHash,
          );

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles: updateBundles,
            context,
          });
        },
      },
      async commit(_context, { changes }) {
        const changedSets = changes.bundles ?? [];
        if (changedSets.length === 0) {
          return;
        }

        await sleep(minMax(config.latency.min, config.latency.max));

        for (const op of changedSets) {
          if (op.operation === "delete") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            bundles.splice(targetIndex, 1);
          } else if (op.operation === "insert") {
            bundles.unshift(op.data);
          } else if (op.operation === "update") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            Object.assign(bundles[targetIndex], op.data);
          }
        }
      },
      channels: {
        async getChannels() {
          await sleep(minMax(config.latency.min, config.latency.max));
          return bundles
            .map((b) => b.channel)
            .filter((c, i, self) => self.indexOf(c) === i);
        },
      },
    };
  },
});

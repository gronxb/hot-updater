import { NIL_UUID } from "@hot-updater/core";
import {
  type Bundle,
  calculatePagination,
  createDatabasePlugin,
  type CursorPage,
  type DatabaseBundlePatch,
  type DatabaseBundleQueryOrder,
  type DatabaseBundleQueryWhere,
  type DatabaseBundleRecord,
  type DatabasePluginCore,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";

import { minMax, sleep } from "./util/utils";

const bundleMatchesQueryWhere = (
  bundle: DatabaseBundleRecord,
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

const sortBundles = <TBundle extends { readonly id: string }>(
  bundles: TBundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const paginateMockBundles = <TBundle extends { readonly id: string }>({
  bundles,
  limit,
  offset,
  cursor,
  orderBy,
}: {
  bundles: TBundle[];
  limit: number;
  offset?: number;
  cursor?: { after?: string; before?: string };
  orderBy?: DatabaseBundleQueryOrder;
}): CursorPage<TBundle> => {
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
        nextCursor:
          data.length > 0 && normalizedOffset + data.length < total
            ? (data.at(-1)?.id ?? null)
            : null,
        previousCursor:
          data.length > 0 && normalizedOffset > 0
            ? (data[0]?.id ?? null)
            : null,
      },
    };
  }

  let data: TBundle[];
  if (cursor?.after) {
    const after = cursor.after;
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(after) < 0
        : bundle.id.localeCompare(after) > 0,
    );
    data = limit > 0 ? candidates.slice(0, limit) : candidates;
  } else if (cursor?.before) {
    const before = cursor.before;
    const candidates = sortedBundles.filter((bundle) =>
      direction === "desc"
        ? bundle.id.localeCompare(before) > 0
        : bundle.id.localeCompare(before) < 0,
    );
    data =
      limit > 0
        ? candidates.slice(Math.max(0, candidates.length - limit))
        : candidates;
  } else {
    data = limit > 0 ? sortedBundles.slice(0, limit) : sortedBundles;
  }

  const firstBundle = data[0];
  const startIndex = firstBundle
    ? sortedBundles.findIndex((bundle) => bundle.id === firstBundle.id)
    : cursor?.after
      ? total
      : 0;
  const pagination = calculatePagination(total, { limit, offset: startIndex });
  const nextCursor =
    data.length > 0 && startIndex + data.length < total
      ? data.at(-1)?.id
      : cursor?.before;
  const previousCursor =
    data.length > 0 && startIndex > 0 ? data[0]?.id : cursor?.after;

  return {
    data,
    pagination: {
      ...pagination,
      nextCursor: nextCursor ?? null,
      previousCursor: previousCursor ?? null,
    },
  };
};

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createDatabasePlugin({
  name: "mockDatabase",
  connect: (config: MockDatabaseConfig): DatabasePluginCore => {
    const bundleRecords = new Map<string, DatabaseBundleRecord>();
    const bundlePatches = new Map<string, DatabaseBundlePatch[]>();

    for (const bundle of config.initialBundles ?? []) {
      bundleRecords.set(bundle.id, toDatabaseBundleRecord(bundle));
      bundlePatches.set(bundle.id, toDatabaseBundlePatches(bundle));
    }

    const getBundles = (): Bundle[] =>
      Array.from(bundleRecords.values()).map((bundle) =>
        toBundleReadModel(bundle, bundlePatches.get(bundle.id) ?? []),
      );

    return {
      bundles: {
        async getById({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return bundleRecords.get(bundleId) ?? null;
        },
        async list(options) {
          const { where, limit, cursor, orderBy, page } = options;
          await sleep(minMax(config.latency.min, config.latency.max));

          const filteredBundles = sortBundles(
            Array.from(bundleRecords.values()).filter((bundle) =>
              bundleMatchesQueryWhere(bundle, where),
            ),
            orderBy,
          );

          return paginateMockBundles({
            bundles: filteredBundles,
            limit,
            offset: page ? (Math.max(1, page) - 1) * limit : undefined,
            cursor,
            orderBy,
          });
        },
        async insert({ bundle }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          bundleRecords.set(bundle.id, bundle);
        },
        async update({ bundleId, patch }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          const current = bundleRecords.get(bundleId);
          if (!current) {
            throw new Error("targetBundleId not found");
          }
          bundleRecords.set(bundleId, { ...current, ...patch, id: bundleId });
        },
        async delete({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          if (!bundleRecords.delete(bundleId)) {
            throw new Error(`Bundle with id ${bundleId} not found`);
          }
        },
      },
      bundlePatches: {
        async list(options) {
          await sleep(minMax(config.latency.min, config.latency.max));
          const where = options.where;
          const patches = Array.from(bundlePatches.values())
            .flat()
            .filter(
              (patch) =>
                !where ||
                ((where.bundleId === undefined ||
                  patch.bundleId === where.bundleId) &&
                  (where.baseBundleId === undefined ||
                    patch.baseBundleId === where.baseBundleId) &&
                  (where.bundleIdIn === undefined ||
                    where.bundleIdIn.includes(patch.bundleId)) &&
                  (where.baseBundleIdIn === undefined ||
                    where.baseBundleIdIn.includes(patch.baseBundleId))),
            )
            .sort((left, right) => {
              const direction = options.orderBy?.direction ?? "asc";
              const field = options.orderBy?.field ?? "orderIndex";
              const result =
                field === "orderIndex"
                  ? left.orderIndex - right.orderIndex
                  : left[field].localeCompare(right[field]);
              return direction === "asc" ? result : -result;
            });

          return paginateMockBundles({
            bundles: patches.map((patch) => ({
              ...patch,
              id: patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
            })),
            limit: options.limit,
            cursor: options.cursor,
            orderBy: undefined,
          });
        },
        async replaceForBundle({ bundleId, patches }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          bundlePatches.set(bundleId, [...patches]);
        },
        async deleteForBundle({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          bundlePatches.delete(bundleId);
        },
        async deleteForBaseBundle({ baseBundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          for (const [bundleId, patches] of bundlePatches) {
            const nextPatches = patches.filter(
              (patch) => patch.baseBundleId !== baseBundleId,
            );
            if (nextPatches.length === 0) {
              bundlePatches.delete(bundleId);
            } else {
              bundlePatches.set(bundleId, nextPatches);
            }
          }
        },
      },
      updateInfo: {
        async get(args) {
          const bundles = getBundles();
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
          });
        },
      },
    };
  },
});

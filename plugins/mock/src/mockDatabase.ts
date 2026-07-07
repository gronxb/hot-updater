import { NIL_UUID } from "@hot-updater/core";
import {
  type Bundle,
  type BundlePatchListQuery,
  createDatabasePlugin,
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

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: Exclude<
    NonNullable<BundlePatchListQuery["orderBy"]>["field"],
    "orderIndex"
  >,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

const materializePatch = (patch: DatabaseBundlePatch): DatabaseBundlePatch => ({
  ...patch,
  id: getPatchId(patch),
});

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

const patchMatchesWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) =>
  !where ||
  ((where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId)));

const sortPatches = (
  patches: readonly DatabaseBundlePatch[],
  orderBy: BundlePatchListQuery["orderBy"],
) =>
  patches.slice().sort((left, right) => {
    const direction = orderBy?.direction ?? "asc";
    const field = orderBy?.field ?? "orderIndex";
    const result =
      field === "orderIndex"
        ? left.orderIndex - right.orderIndex ||
          getPatchId(left).localeCompare(getPatchId(right))
        : getPatchStringField(left, field).localeCompare(
            getPatchStringField(right, field),
          );
    return direction === "asc" ? result : -result;
  });

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
        async findMany({ where, orderBy, window }) {
          await sleep(minMax(config.latency.min, config.latency.max));

          const filteredBundles = sortBundles(
            Array.from(bundleRecords.values()).filter((bundle) =>
              bundleMatchesQueryWhere(bundle, where),
            ),
            orderBy,
          );

          return filteredBundles.slice(
            window.offset,
            window.offset + window.limit,
          );
        },
        async count({ where }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return Array.from(bundleRecords.values()).filter((bundle) =>
            bundleMatchesQueryWhere(bundle, where),
          ).length;
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
        async findMany({ where, orderBy, window }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          const patches = sortPatches(
            Array.from(bundlePatches.values())
              .flat()
              .filter((patch) => patchMatchesWhere(patch, where))
              .map(materializePatch),
            orderBy,
          );

          return patches.slice(window.offset, window.offset + window.limit);
        },
        async count({ where }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return Array.from(bundlePatches.values())
            .flat()
            .filter((patch) => patchMatchesWhere(patch, where)).length;
        },
        async getById({ patchId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return (
            Array.from(bundlePatches.values())
              .flat()
              .map(materializePatch)
              .find((patch) => getPatchId(patch) === patchId) ?? null
          );
        },
        async insert({ patch }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          const nextPatch = materializePatch(patch);
          const patches =
            bundlePatches
              .get(nextPatch.bundleId)
              ?.filter((item) => getPatchId(item) !== getPatchId(nextPatch)) ??
            [];
          bundlePatches.set(
            nextPatch.bundleId,
            sortPatches([...patches, nextPatch], undefined),
          );
        },
        async update({ patchId, patch }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          for (const [bundleId, patches] of bundlePatches) {
            bundlePatches.set(
              bundleId,
              patches.map((current) =>
                getPatchId(current) === patchId
                  ? materializePatch({ ...current, ...patch })
                  : current,
              ),
            );
          }
        },
        async delete({ patchId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          for (const [bundleId, patches] of bundlePatches) {
            const nextPatches = patches.filter(
              (patch) => getPatchId(patch) !== patchId,
            );
            bundlePatches.set(bundleId, nextPatches);
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

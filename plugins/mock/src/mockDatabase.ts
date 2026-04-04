import {
  type Bundle,
  calculatePagination,
  createDatabasePlugin,
  type DatabaseBundleQueryOrder,
  type DatabaseBundleQueryWhere,
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

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createDatabasePlugin<MockDatabaseConfig>({
  name: "mockDatabase",
  factory: (config) => {
    const bundles: Bundle[] = config.initialBundles ?? [];

    return {
      async getBundleById(bundleId: string) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles.find((b) => b.id === bundleId) ?? null;
      },

      async getBundles(options) {
        const { where, limit, offset, orderBy } = options ?? {};
        await sleep(minMax(config.latency.min, config.latency.max));

        const filteredBundles = sortBundles(
          bundles.filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
          orderBy,
        );

        const total = filteredBundles.length;
        const data = limit
          ? filteredBundles.slice(offset, offset + limit)
          : filteredBundles;
        const pagination = calculatePagination(total, { limit, offset });

        return {
          data,
          pagination,
        };
      },

      async getChannels() {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles
          .map((b) => b.channel)
          .filter((c, i, self) => self.indexOf(c) === i);
      },

      async commitBundle({ changedSets }) {
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
    };
  },
});

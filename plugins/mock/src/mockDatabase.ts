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

const paginateMockBundles = ({
  bundles,
  limit,
  cursor,
  orderBy,
}: {
  bundles: Bundle[];
  limit: number;
  cursor?: { after?: string; before?: string };
  orderBy?: DatabaseBundleQueryOrder;
}) => {
  const sortedBundles = sortBundles(bundles, orderBy);
  const direction = orderBy?.direction ?? "desc";

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

  const total = sortedBundles.length;
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

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createDatabasePlugin<MockDatabaseConfig>({
  name: "mockDatabase",
  factory: (config) => {
    const bundles: Bundle[] = config.initialBundles ?? [];

    return {
      supportsCursorPagination: true,
      async getBundleById(bundleId: string) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles.find((b) => b.id === bundleId) ?? null;
      },

      async getBundles(options) {
        const { where, limit, cursor, orderBy } = options ?? {};
        await sleep(minMax(config.latency.min, config.latency.max));

        const filteredBundles = sortBundles(
          bundles.filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
          orderBy,
        );

        return {
          ...paginateMockBundles({
            bundles: filteredBundles,
            limit,
            cursor,
            orderBy,
          }),
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

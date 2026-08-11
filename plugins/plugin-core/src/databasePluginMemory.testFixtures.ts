import { createDatabasePlugin } from "./createDatabasePlugin";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ClientAccessKeyRow,
  DatabaseBundleQueryWhere,
  DatabaseCommit,
  DatabasePlugin,
} from "./types";

const matchesBundleWhere = (
  row: BundleRow,
  where: DatabaseBundleQueryWhere | undefined,
): boolean => {
  if (!where) return true;
  if (where.channel !== undefined && row.channel !== where.channel)
    return false;
  if (where.platform !== undefined && row.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && row.enabled !== where.enabled)
    return false;
  if (
    where.targetAppVersion !== undefined &&
    row.target_app_version !== where.targetAppVersion
  )
    return false;
  if (
    where.targetAppVersionIn !== undefined &&
    (row.target_app_version === null ||
      !where.targetAppVersionIn.includes(row.target_app_version))
  )
    return false;
  if (where.targetAppVersionNotNull && row.target_app_version === null)
    return false;
  if (
    where.fingerprintHash !== undefined &&
    row.fingerprint_hash !== where.fingerprintHash
  )
    return false;
  const id = where.id;
  if (!id) return true;
  if (id.eq !== undefined && row.id !== id.eq) return false;
  if (id.gt !== undefined && row.id <= id.gt) return false;
  if (id.gte !== undefined && row.id < id.gte) return false;
  if (id.lt !== undefined && row.id >= id.lt) return false;
  if (id.lte !== undefined && row.id > id.lte) return false;
  return id.in === undefined || id.in.includes(row.id);
};

const replaceMap = <T>(target: Map<string, T>, source: Map<string, T>) => {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
};

export const createMemoryDatabasePlugin = (): DatabasePlugin => {
  const bundles = new Map<string, BundleRow>();
  const patches = new Map<string, BundlePatchRow>();
  const events = new Map<string, BundleEventRow>();
  const accessKeys = new Map<string, ClientAccessKeyRow>();

  const commit = async (input: DatabaseCommit) => {
    const nextBundles = new Map(bundles);
    const nextPatches = new Map(patches);
    for (const mutation of input.mutations) {
      if (
        mutation.operation === "update" &&
        !nextBundles.has(mutation.bundleId)
      ) {
        return { applied: false, missingBundleId: mutation.bundleId } as const;
      }
      for (const change of mutation.changes) {
        if (change.table === "bundles") {
          switch (change.operation) {
            case "insert":
              nextBundles.set(change.row.id, structuredClone(change.row));
              break;
            case "update": {
              const current = nextBundles.get(change.id);
              if (!current)
                return { applied: false, missingBundleId: change.id };
              nextBundles.set(change.id, { ...current, ...change.update });
              break;
            }
            case "delete":
              nextBundles.delete(change.id);
              for (const patch of nextPatches.values()) {
                if (
                  patch.bundle_id === change.id ||
                  patch.base_bundle_id === change.id
                ) {
                  nextPatches.delete(patch.id);
                }
              }
              break;
          }
          continue;
        }
        if (change.operation === "insert") {
          nextPatches.set(change.row.id, structuredClone(change.row));
        } else {
          for (const patch of nextPatches.values()) {
            if (patch.bundle_id === change.bundleId)
              nextPatches.delete(patch.id);
          }
        }
      }
    }
    replaceMap(bundles, nextBundles);
    replaceMap(patches, nextPatches);
    return { applied: true } as const;
  };

  return createDatabasePlugin({
    name: "memory-database",
    bundles: {
      async findById(id) {
        return structuredClone(bundles.get(id) ?? null);
      },
      async findMany(query) {
        const rows = [...bundles.values()].filter((row) =>
          matchesBundleWhere(row, query.where),
        );
        rows.sort((left, right) => left.id.localeCompare(right.id));
        if (query.orderBy.direction === "desc") rows.reverse();
        return structuredClone(
          rows.slice(query.offset, query.offset + query.limit),
        );
      },
      async count(where) {
        return [...bundles.values()].filter((row) =>
          matchesBundleWhere(row, where),
        ).length;
      },
    },
    bundlePatches: {
      async findByBundleIds(bundleIds) {
        const ids = new Set(bundleIds);
        return structuredClone(
          [...patches.values()]
            .filter((row) => ids.has(row.bundle_id))
            .sort(
              (left, right) =>
                left.order_index - right.order_index ||
                left.id.localeCompare(right.id),
            ),
        );
      },
    },
    analytics: {
      async append(row) {
        events.set(row.id, structuredClone(row));
      },
      async scan(input) {
        return structuredClone(
          [...events.values()]
            .filter(
              (row) =>
                row.received_at_ms < input.beforeReceivedAtMs &&
                (input.after === undefined ||
                  row.received_at_ms > input.after.receivedAtMs ||
                  (row.received_at_ms === input.after.receivedAtMs &&
                    row.id > input.after.id)),
            )
            .sort(
              (left, right) =>
                left.received_at_ms - right.received_at_ms ||
                left.id.localeCompare(right.id),
            )
            .slice(0, input.limit),
        );
      },
    },
    clientAccessKeys: {
      async create(row) {
        if ([...accessKeys.values()].some(({ hash }) => hash === row.hash)) {
          return "existing";
        }
        accessKeys.set(row.id, structuredClone(row));
        return "created";
      },
      async findByHash(hash) {
        return structuredClone(
          [...accessKeys.values()].find((row) => row.hash === hash) ?? null,
        );
      },
      async list() {
        return structuredClone([...accessKeys.values()]);
      },
      async revoke(input) {
        const current = accessKeys.get(input.id);
        if (!current) return null;
        const revoked = { ...current, revoked_at_ms: input.revokedAtMs };
        accessKeys.set(input.id, revoked);
        return structuredClone(revoked);
      },
    },
    commit,
  });
};

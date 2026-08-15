import { createDatabasePlugin } from "./createDatabasePlugin";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
  DatabaseBundleQueryWhere,
  DatabaseCommit,
  DatabasePlugin,
  ReleaseCatalogRow,
  ReleaseRow,
} from "./types";

const matchesBundleWhere = (
  row: BundleRow,
  where: DatabaseBundleQueryWhere | undefined,
): boolean => {
  if (!where) return true;
  if (where.platform !== undefined && row.platform !== where.platform)
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
  const releases = new Map<string, ReleaseRow>();
  const releaseCatalogs = new Map<string, ReleaseCatalogRow>();
  const channels = new Map<string, ChannelRow>();
  const accessKeys = new Map<string, ClientAccessKeyRow>();

  const commit = async (input: DatabaseCommit) => {
    for (const expectation of input.expectations ?? []) {
      const actualVersion =
        expectation.model === "releases"
          ? (releases.get(expectation.id)?.revision ?? null)
          : (releaseCatalogs.get(expectation.scopeKey)?.generation ?? null);
      const expectedVersion =
        expectation.model === "releases"
          ? expectation.revision
          : expectation.generation;
      if (actualVersion !== expectedVersion) {
        return {
          committed: false,
          conflict: {
            actualVersion,
            changeIndex: -1,
            expectedVersion,
            key:
              expectation.model === "releases"
                ? expectation.id
                : expectation.scopeKey,
            model: expectation.model,
            reason: "version_conflict",
          },
        } as const;
      }
    }
    const nextBundles = new Map(bundles);
    const nextPatches = new Map(patches);
    const nextEvents = new Map(events);
    const nextReleases = new Map(releases);
    const nextReleaseCatalogs = new Map(releaseCatalogs);
    const nextChannels = new Map(channels);
    const nextAccessKeys = new Map(accessKeys);
    for (const [changeIndex, change] of input.changes.entries()) {
      switch (change.model) {
        case "bundles":
          if (change.operation === "insert") {
            nextBundles.set(change.row.id, structuredClone(change.row));
          } else if (change.operation === "update") {
            const current = nextBundles.get(change.where.id);
            if (!current) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              } as const;
            }
            nextBundles.set(change.where.id, {
              ...current,
              ...change.update,
            });
          } else {
            if (
              [...nextReleases.values()].some(
                ({ bundle_id }) => bundle_id === change.where.id,
              )
            ) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "referenced" },
              } as const;
            }
            if (!nextBundles.delete(change.where.id)) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              } as const;
            }
            for (const patch of nextPatches.values()) {
              if (
                patch.bundle_id === change.where.id ||
                patch.base_bundle_id === change.where.id
              ) {
                nextPatches.delete(patch.id);
              }
            }
          }
          break;
        case "releases":
          if (change.operation === "insert") {
            nextReleases.set(change.row.id, structuredClone(change.row));
          } else if (change.operation === "update") {
            const current = nextReleases.get(change.where.id);
            if (!current) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              } as const;
            }
            nextReleases.set(change.where.id, {
              ...current,
              ...change.update,
            });
          } else if (!nextReleases.delete(change.where.id)) {
            return {
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            } as const;
          }
          break;
        case "releaseCatalogs":
          nextReleaseCatalogs.set(
            change.row.scope_key,
            structuredClone(change.row),
          );
          break;
        case "bundlePatches":
          if (change.operation === "insert") {
            nextPatches.set(change.row.id, structuredClone(change.row));
          } else {
            for (const patch of nextPatches.values()) {
              if (patch.bundle_id === change.where.bundleId) {
                nextPatches.delete(patch.id);
              }
            }
          }
          break;
        case "channels":
          if (change.operation === "insert") {
            const existing = [...nextChannels.values()].find(
              ({ name }) => name === change.row.name,
            );
            if (!existing) {
              nextChannels.set(change.row.id, structuredClone(change.row));
            }
          } else {
            if (
              [...nextReleases.values()].some(
                ({ channel_id }) => channel_id === change.where.id,
              )
            ) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "referenced" },
              } as const;
            }
            if (!nextChannels.delete(change.where.id)) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              } as const;
            }
          }
          break;
        case "analytics":
          nextEvents.set(change.row.id, structuredClone(change.row));
          break;
        case "clientAccessKeys":
          if (change.operation === "insert") {
            const existing = [...nextAccessKeys.values()].find(
              ({ hash }) => hash === change.row.hash,
            );
            if (!existing) {
              nextAccessKeys.set(change.row.id, structuredClone(change.row));
            }
          } else {
            const current = nextAccessKeys.get(change.where.id);
            if (!current) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              } as const;
            }
            nextAccessKeys.set(change.where.id, {
              ...current,
              revoked_at_ms: change.update.revokedAtMs,
            });
          }
          break;
      }
    }
    replaceMap(bundles, nextBundles);
    replaceMap(patches, nextPatches);
    replaceMap(events, nextEvents);
    replaceMap(releases, nextReleases);
    replaceMap(releaseCatalogs, nextReleaseCatalogs);
    replaceMap(channels, nextChannels);
    replaceMap(accessKeys, nextAccessKeys);
    return { committed: true } as const;
  };

  return createDatabasePlugin({
    name: "memory-database",
    models: {
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
      releases: {
        async findById(id) {
          return structuredClone(releases.get(id) ?? null);
        },
        async findMany(input) {
          return structuredClone(
            [...releases.values()]
              .filter(
                (row) =>
                  (input.beforeReleaseId === undefined ||
                    row.id < input.beforeReleaseId) &&
                  (input.bundleId === undefined ||
                    row.bundle_id === input.bundleId) &&
                  (input.channelId === undefined ||
                    row.channel_id === input.channelId) &&
                  (input.enabled === undefined ||
                    row.enabled === input.enabled) &&
                  (input.platform === undefined ||
                    row.platform === input.platform),
              )
              .sort((left, right) => right.id.localeCompare(left.id))
              .slice(0, input.limit),
          );
        },
        async findManyByScope(input) {
          return structuredClone(
            [...releases.values()]
              .filter(
                (row) =>
                  row.scope_key === input.scopeKey &&
                  (input.afterReleaseId === undefined ||
                    row.id > input.afterReleaseId),
              )
              .sort((left, right) => left.id.localeCompare(right.id))
              .slice(0, input.limit),
          );
        },
      },
      releaseCatalogs: {
        async findByScopeKey(scopeKey) {
          return structuredClone(releaseCatalogs.get(scopeKey) ?? null);
        },
        async findMany(input) {
          return structuredClone(
            [...releaseCatalogs.values()]
              .filter(
                (row) =>
                  input.afterScopeKey === undefined ||
                  row.scope_key > input.afterScopeKey,
              )
              .sort((left, right) =>
                left.scope_key.localeCompare(right.scope_key),
              )
              .slice(0, input.limit),
          );
        },
      },
      channels: {
        async insert({ row }) {
          const existing = [...channels.values()].find(
            ({ name }) => name === row.name,
          );
          if (existing) {
            return { row: structuredClone(existing), inserted: false };
          }
          channels.set(row.id, structuredClone(row));
          return { row: structuredClone(row), inserted: true };
        },
        async list() {
          return {
            channels: structuredClone(
              [...channels.values()].sort((left, right) =>
                left.name.localeCompare(right.name),
              ),
            ),
          };
        },
        async delete({ id }) {
          if (!channels.has(id)) {
            return { deleted: false, reason: "not_found" } as const;
          }
          if (
            [...releases.values()].some(({ channel_id }) => channel_id === id)
          ) {
            return { deleted: false, reason: "not_empty" } as const;
          }
          channels.delete(id);
          return { deleted: true } as const;
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
    },
    commit,
  });
};

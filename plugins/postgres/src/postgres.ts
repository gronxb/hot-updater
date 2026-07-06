import {
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  BundleEventListQuery,
  BundleEventPayload,
  BundlePatchListQuery,
  CursorPage,
  DatabasePluginCore,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  Platform,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import { type ControlledTransaction, Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

import { getUpdateInfo } from "./getUpdateInfo";
import type {
  Database,
  PostgresBundleEventRow,
  PostgresBundlePatchRow,
  PostgresBundleRow,
} from "./types";

export interface PostgresConfig extends PoolConfig {}

const normalizeMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return normalizeMetadata(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Bundle["metadata"];
  }

  return undefined;
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const mapPatchRowToPatch = (row: PostgresBundlePatchRow) => ({
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
});

const mapRowToBundle = (
  data: PostgresBundleRow,
  patchRows: PostgresBundlePatchRow[] = [],
): Bundle => {
  const rawMetadata = normalizeMetadata(data.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        left.order_index - right.order_index ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map(mapPatchRowToPatch);
  const primaryPatch = patches[0] ?? null;

  return {
    enabled: data.enabled,
    shouldForceUpdate: data.should_force_update,
    fileHash: data.file_hash,
    gitCommitHash: data.git_commit_hash,
    id: data.id,
    message: data.message,
    platform: data.platform,
    targetAppVersion: data.target_app_version,
    channel: data.channel,
    storageUri: data.storage_uri,
    fingerprintHash: data.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: data.manifest_storage_uri ?? null,
    manifestFileHash: data.manifest_file_hash ?? null,
    assetBaseStorageUri: data.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount: data.rollout_cohort_count,
    targetCohorts: data.target_cohorts,
  };
};

const bundleToRowValues = (
  bundle: Bundle | DatabaseBundleRecord,
): Database["bundles"] => {
  const bundleReadModel =
    "patches" in bundle ? bundle : toBundleReadModel(bundle);
  return {
    id: bundleReadModel.id,
    enabled: bundleReadModel.enabled,
    should_force_update: bundleReadModel.shouldForceUpdate,
    file_hash: bundleReadModel.fileHash,
    git_commit_hash: bundleReadModel.gitCommitHash,
    message: bundleReadModel.message,
    platform: bundleReadModel.platform,
    target_app_version: bundleReadModel.targetAppVersion,
    channel: bundleReadModel.channel,
    storage_uri: bundleReadModel.storageUri,
    fingerprint_hash: bundleReadModel.fingerprintHash,
    metadata: stripBundleArtifactMetadata(bundleReadModel.metadata) ?? {},
    manifest_storage_uri: getManifestStorageUri(bundleReadModel),
    manifest_file_hash: getManifestFileHash(bundleReadModel),
    asset_base_storage_uri: getAssetBaseStorageUri(bundleReadModel),
    rollout_cohort_count: bundleReadModel.rolloutCohortCount ?? null,
    target_cohorts: bundleReadModel.targetCohorts ?? null,
  };
};

const rowToDatabaseBundleRecord = (row: PostgresBundleRow) =>
  toDatabaseBundleRecord(mapRowToBundle(row));

const rowToDatabaseBundlePatch = (
  row: PostgresBundlePatchRow,
): DatabaseBundlePatch => ({
  id: row.id,
  bundleId: row.bundle_id,
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
  orderIndex: row.order_index,
});

const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): Database["bundle_patches"] => ({
  id: patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

const isAppReadyPayload = (value: unknown): value is BundleEventPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<Record<keyof BundleEventPayload, unknown>>;
  return (
    (payload.status === "STABLE" || payload.status === "RECOVERED") &&
    typeof payload.sdkVersion === "string" &&
    typeof payload.defaultChannel === "string" &&
    typeof payload.isChannelSwitched === "boolean"
  );
};

const parseEventPayload = (value: unknown): BundleEventPayload => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isAppReadyPayload(parsed)) {
    throw new Error("Invalid bundle event payload.");
  }
  return parsed;
};

const rowToDatabaseBundleEvent = (
  row: PostgresBundleEventRow,
): DatabaseBundleEvent => {
  if (row.kind !== "APP_READY") {
    throw new Error(`Unsupported bundle event kind: ${row.kind}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    installId: row.install_id,
    activeBundleId: row.active_bundle_id,
    previousActiveBundleId: row.previous_active_bundle_id,
    crashedBundleId: row.crashed_bundle_id,
    platform: row.platform,
    channel: row.channel,
    appVersion: row.app_version,
    fingerprintHash: row.fingerprint_hash,
    cohort: row.cohort,
    payload: parseEventPayload(row.payload),
  };
};

const databaseBundleEventToRow = (
  event: DatabaseBundleEvent,
): Database["bundle_events"] => ({
  id: event.id,
  kind: event.kind,
  install_id: event.installId,
  active_bundle_id: event.activeBundleId,
  previous_active_bundle_id: event.previousActiveBundleId ?? null,
  crashed_bundle_id: event.crashedBundleId ?? null,
  platform: event.platform,
  channel: event.channel,
  app_version: event.appVersion ?? null,
  fingerprint_hash: event.fingerprintHash ?? null,
  cohort: event.cohort ?? null,
  payload: event.payload,
});

const eventMatchesWhere = (
  event: DatabaseBundleEvent,
  where: BundleEventListQuery["where"] | undefined,
) =>
  !where ||
  ((where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort));

const paginateItems = <TItem>({
  cursor,
  getCursor,
  items,
  limit,
  page,
}: {
  readonly cursor?: { readonly after?: string; readonly before?: string };
  readonly getCursor: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly limit: number;
  readonly page?: number;
}): CursorPage<TItem> => {
  const total = items.length;
  const pageOffset = page ? (Math.max(1, page) - 1) * limit : undefined;
  let startIndex =
    pageOffset === undefined ? 0 : Math.min(pageOffset, Math.max(0, total));
  let endIndex = limit > 0 ? startIndex + limit : total;

  if (pageOffset === undefined && cursor?.after) {
    const afterIndex = items.findIndex(
      (item) => getCursor(item) === cursor.after,
    );
    startIndex = afterIndex >= 0 ? afterIndex + 1 : total;
    endIndex = limit > 0 ? startIndex + limit : total;
  } else if (pageOffset === undefined && cursor?.before) {
    const beforeIndex = items.findIndex(
      (item) => getCursor(item) === cursor.before,
    );
    endIndex = beforeIndex >= 0 ? beforeIndex : 0;
    startIndex = limit > 0 ? Math.max(0, endIndex - limit) : 0;
  }

  const data = items.slice(startIndex, endIndex);
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });

  return {
    data,
    pagination: {
      ...pagination,
      nextCursor:
        data.length > 0 && startIndex + data.length < total
          ? getCursor(data[data.length - 1]!)
          : null,
      previousCursor:
        data.length > 0 && startIndex > 0 ? getCursor(data[0]!) : null,
    },
  };
};

const hasEmptySetFilter = (where: DatabaseBundleQueryWhere | undefined) =>
  where?.targetAppVersionIn?.length === 0 || where?.id?.in?.length === 0;

type PostgresExecutor = Kysely<Database> | ControlledTransaction<Database>;

export const postgres = createDatabasePlugin({
  name: "postgres",
  connect: (config: PostgresConfig) => {
    const pool = new Pool(config);
    const dialect = new PostgresDialect({ pool });
    const db = new Kysely<Database>({ dialect });

    const createCore = (executor: PostgresExecutor): DatabasePluginCore => {
      const applyBundleWhere = <TQuery extends object>(
        query: TQuery,
        where: DatabaseBundleQueryWhere | undefined,
      ): TQuery => {
        let next = query as {
          where: (column: string, op: string, value?: unknown) => unknown;
        };
        if (where?.channel !== undefined) {
          next = next.where("channel", "=", where.channel) as typeof next;
        }
        if (where?.platform !== undefined) {
          next = next.where(
            "platform",
            "=",
            where.platform as Platform,
          ) as typeof next;
        }
        if (where?.enabled !== undefined) {
          next = next.where("enabled", "=", where.enabled) as typeof next;
        }
        if (where?.fingerprintHash !== undefined) {
          next =
            where.fingerprintHash === null
              ? (next.where("fingerprint_hash", "is", null) as typeof next)
              : (next.where(
                  "fingerprint_hash",
                  "=",
                  where.fingerprintHash,
                ) as typeof next);
        }
        if (where?.targetAppVersion !== undefined) {
          next =
            where.targetAppVersion === null
              ? (next.where("target_app_version", "is", null) as typeof next)
              : (next.where(
                  "target_app_version",
                  "=",
                  where.targetAppVersion,
                ) as typeof next);
        }
        if (where?.targetAppVersionIn) {
          next = next.where(
            "target_app_version",
            "in",
            where.targetAppVersionIn,
          ) as typeof next;
        }
        if (where?.targetAppVersionNotNull) {
          next = next.where(
            "target_app_version",
            "is not",
            null,
          ) as typeof next;
        }
        if (where?.id?.eq) {
          next = next.where("id", "=", where.id.eq) as typeof next;
        }
        if (where?.id?.gt) {
          next = next.where("id", ">", where.id.gt) as typeof next;
        }
        if (where?.id?.gte) {
          next = next.where("id", ">=", where.id.gte) as typeof next;
        }
        if (where?.id?.lt) {
          next = next.where("id", "<", where.id.lt) as typeof next;
        }
        if (where?.id?.lte) {
          next = next.where("id", "<=", where.id.lte) as typeof next;
        }
        if (where?.id?.in) {
          next = next.where("id", "in", where.id.in) as typeof next;
        }

        return next as TQuery;
      };

      const upsertBundleRecord = async (bundle: DatabaseBundleRecord) => {
        const values = bundleToRowValues(bundle);
        const { id: _id, ...updateValues } = values;
        await executor
          .insertInto("bundles")
          .values(values)
          .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
          .execute();
      };

      return {
        bundles: {
          async getById({ bundleId }) {
            const data = await executor
              .selectFrom("bundles")
              .selectAll()
              .where("id", "=", bundleId)
              .executeTakeFirst();

            return data ? rowToDatabaseBundleRecord(data) : null;
          },

          async list(options) {
            if (hasEmptySetFilter(options.where)) {
              return paginateItems({
                items: [] as DatabaseBundleRecord[],
                limit: options.limit,
                cursor: options.cursor,
                getCursor: (bundle) => bundle.id,
              });
            }

            const orderBy = options.orderBy ?? {
              field: "id",
              direction: "desc",
            };
            const rows = await applyBundleWhere(
              executor.selectFrom("bundles").selectAll(),
              options.where,
            )
              .orderBy("id", orderBy.direction)
              .execute();
            const page = paginateItems({
              items: rows,
              limit: options.limit,
              cursor: options.cursor,
              page: options.page,
              getCursor: (row) => row.id,
            });

            return {
              ...page,
              data: page.data.map(rowToDatabaseBundleRecord),
            };
          },

          async insert({ bundle }) {
            await upsertBundleRecord(bundle);
          },

          async update({ bundleId, patch }) {
            const current = await executor
              .selectFrom("bundles")
              .selectAll()
              .where("id", "=", bundleId)
              .executeTakeFirst();
            if (!current) {
              throw new Error("targetBundleId not found");
            }
            await upsertBundleRecord({
              ...rowToDatabaseBundleRecord(current),
              ...patch,
              id: bundleId,
            });
          },

          async delete({ bundleId }) {
            await executor
              .deleteFrom("bundles")
              .where("id", "=", bundleId)
              .execute();
          },
        },

        bundlePatches: {
          async list(options: BundlePatchListQuery) {
            const rows = await executor
              .selectFrom("bundle_patches")
              .selectAll()
              .orderBy("order_index", "asc")
              .execute();
            const patches = rows
              .map(rowToDatabaseBundlePatch)
              .filter((patch) => {
                const where = options.where;
                return (
                  !where ||
                  ((where.bundleId === undefined ||
                    patch.bundleId === where.bundleId) &&
                    (where.baseBundleId === undefined ||
                      patch.baseBundleId === where.baseBundleId) &&
                    (where.bundleIdIn === undefined ||
                      where.bundleIdIn.includes(patch.bundleId)) &&
                    (where.baseBundleIdIn === undefined ||
                      where.baseBundleIdIn.includes(patch.baseBundleId)))
                );
              })
              .sort((left, right) => {
                const direction = options.orderBy?.direction ?? "asc";
                const field = options.orderBy?.field ?? "orderIndex";
                const result =
                  field === "orderIndex"
                    ? left.orderIndex - right.orderIndex
                    : left[field].localeCompare(right[field]);
                return direction === "asc" ? result : -result;
              });

            return paginateItems({
              items: patches,
              limit: options.limit,
              cursor: options.cursor,
              getCursor: (patch) =>
                patch.id ??
                buildBundlePatchId(patch.bundleId, patch.baseBundleId),
            });
          },

          async replaceForBundle({ bundleId, patches }) {
            await executor
              .deleteFrom("bundle_patches")
              .where("bundle_id", "=", bundleId)
              .execute();
            const patchRows = patches.map(databaseBundlePatchToRow);
            if (patchRows.length > 0) {
              await executor
                .insertInto("bundle_patches")
                .values(patchRows)
                .execute();
            }
          },

          async deleteForBundle({ bundleId }) {
            await executor
              .deleteFrom("bundle_patches")
              .where("bundle_id", "=", bundleId)
              .execute();
          },

          async deleteForBaseBundle({ baseBundleId }) {
            await executor
              .deleteFrom("bundle_patches")
              .where("base_bundle_id", "=", baseBundleId)
              .execute();
          },
        },

        bundleEvents: {
          async list(options: BundleEventListQuery) {
            const rows = await executor
              .selectFrom("bundle_events")
              .selectAll()
              .orderBy("id", options.orderBy?.direction ?? "desc")
              .execute();
            const events = rows
              .map(rowToDatabaseBundleEvent)
              .filter((event) => eventMatchesWhere(event, options.where));

            return paginateItems({
              items: events,
              limit: options.limit,
              cursor: options.cursor,
              getCursor: (event) => event.id,
            });
          },

          async append({ event }) {
            await executor
              .insertInto("bundle_events")
              .values(databaseBundleEventToRow(event))
              .execute();
          },
        },

        updateInfo: {
          async get(args) {
            return getUpdateInfo(pool, args);
          },
        },
      };
    };

    return {
      ...createCore(db),
      async beginTransaction() {
        const trx = await db.startTransaction().execute();
        return {
          core: createCore(trx),
          commit: async () => {
            await trx.commit().execute();
          },
          rollback: async () => {
            await trx.rollback().execute();
          },
        };
      },
      async close() {
        await db.destroy();
        await pool.end();
      },
    };
  },
});

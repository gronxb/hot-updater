import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  NIL_UUID,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  BundleEventListQuery,
  BundleEventPayload,
  BundleListQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginCore,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";
import minify from "pg-minify";

export interface D1DatabaseConfig {
  databaseId: string;
  accountId: string;
  cloudflareApiToken: string;
}

// Helper interfaces for clarity
type QueryConditions = DatabaseBundleQueryWhere;

interface BuildQueryResult {
  sql: string;
  params: unknown[];
}

const buildJsonEachInClause = (
  columnName: string,
  values: string[],
  params: unknown[],
) => {
  if (values.length === 0) {
    return "1 = 0";
  }

  params.push(JSON.stringify(values));
  return `${columnName} IN (SELECT value FROM json_each(?))`;
};

interface D1BundleRow {
  id: string;
  channel: string;
  enabled: number | boolean;
  should_force_update: number | boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: "ios" | "android";
  target_app_version: string | null;
  storage_uri: string;
  fingerprint_hash: string | null;
  metadata: unknown;
  manifest_storage_uri?: string | null;
  manifest_file_hash?: string | null;
  asset_base_storage_uri?: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string | null;
}

interface D1BundlePatchRow {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number | null;
}

interface D1BundleEventRow {
  id: string;
  kind: string;
  install_id: string;
  active_bundle_id: string;
  previous_active_bundle_id: string | null;
  crashed_bundle_id: string | null;
  platform: "ios" | "android";
  channel: string;
  app_version: string | null;
  fingerprint_hash: string | null;
  cohort: string | null;
  payload: unknown;
}

interface D1QueryPage {
  result: Array<{ results?: unknown[] }>;
}

interface D1PaginatedQuery {
  iterPages: () => AsyncIterable<D1QueryPage>;
}

async function resolvePage<T>(singlePage: D1PaginatedQuery): Promise<T[]> {
  const results: T[] = [];
  for await (const page of singlePage.iterPages()) {
    const data = page.result.flatMap((row) => row.results ?? []);
    results.push(...(data as T[]));
  }
  return results;
}

// Helper function to build WHERE clause
function buildWhereClause(conditions: QueryConditions): BuildQueryResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (conditions.channel) {
    clauses.push("channel = ?");
    params.push(conditions.channel);
  }

  if (conditions.platform) {
    clauses.push("platform = ?");
    params.push(conditions.platform);
  }

  if (conditions.enabled !== undefined) {
    clauses.push("enabled = ?");
    params.push(conditions.enabled ? 1 : 0);
  }

  if (conditions.id?.in) {
    clauses.push(buildJsonEachInClause("id", conditions.id.in, params));
  }

  if (conditions.id?.eq) {
    clauses.push("id = ?");
    params.push(conditions.id.eq);
  }

  if (conditions.id?.gt) {
    clauses.push("id > ?");
    params.push(conditions.id.gt);
  }

  if (conditions.id?.gte) {
    clauses.push("id >= ?");
    params.push(conditions.id.gte);
  }

  if (conditions.id?.lt) {
    clauses.push("id < ?");
    params.push(conditions.id.lt);
  }

  if (conditions.id?.lte) {
    clauses.push("id <= ?");
    params.push(conditions.id.lte);
  }

  if (conditions.targetAppVersionNotNull) {
    clauses.push("target_app_version IS NOT NULL");
  }

  if (conditions.targetAppVersion !== undefined) {
    if (conditions.targetAppVersion === null) {
      clauses.push("target_app_version IS NULL");
    } else {
      clauses.push("target_app_version = ?");
      params.push(conditions.targetAppVersion);
    }
  }

  if (conditions.targetAppVersionIn) {
    clauses.push(
      buildJsonEachInClause(
        "target_app_version",
        conditions.targetAppVersionIn,
        params,
      ),
    );
  }

  if (conditions.fingerprintHash !== undefined) {
    if (conditions.fingerprintHash === null) {
      clauses.push("fingerprint_hash IS NULL");
    } else {
      clauses.push("fingerprint_hash = ?");
      params.push(conditions.fingerprintHash);
    }
  }

  const whereClause =
    clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  return { sql: whereClause, params };
}

function parseTargetCohorts(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      return null;
    }
  }
  return null;
}

const parseMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return parseMetadata(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Bundle["metadata"])
    : undefined;
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const bundleRecordToRow = (bundleRecord: DatabaseBundleRecord): D1BundleRow => {
  const bundle = toBundleReadModel(bundleRecord);
  return {
    id: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled ? 1 : 0,
    should_force_update: bundle.shouldForceUpdate ? 1 : 0,
    file_hash: bundle.fileHash,
    git_commit_hash: bundle.gitCommitHash ?? null,
    message: bundle.message ?? null,
    platform: bundle.platform,
    target_app_version: bundle.targetAppVersion,
    storage_uri: bundle.storageUri,
    fingerprint_hash: bundle.fingerprintHash,
    metadata: JSON.stringify(
      stripBundleArtifactMetadata(bundle.metadata) ?? {},
    ),
    manifest_storage_uri: getManifestStorageUri(bundle),
    manifest_file_hash: getManifestFileHash(bundle),
    asset_base_storage_uri: getAssetBaseStorageUri(bundle),
    rollout_cohort_count:
      bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    target_cohorts: bundle.targetCohorts
      ? JSON.stringify(bundle.targetCohorts)
      : null,
  };
};

const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): D1BundlePatchRow => ({
  id: patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

const rowToDatabaseBundlePatch = (
  row: D1BundlePatchRow,
): DatabaseBundlePatch => ({
  id: row.id,
  bundleId: row.bundle_id,
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
  orderIndex: row.order_index ?? 0,
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
  row: D1BundleEventRow,
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

function transformRowToBundle(
  row: D1BundleRow,
  patchRows: D1BundlePatchRow[] = [],
): Bundle {
  const rawMetadata = parseMetadata(row.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        (left.order_index ?? 0) - (right.order_index ?? 0) ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map((patch) => ({
      baseBundleId: patch.base_bundle_id,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    }));
  const primaryPatch = patches[0] ?? null;

  return {
    id: row.id,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    shouldForceUpdate: Boolean(row.should_force_update),
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    message: row.message,
    platform: row.platform,
    targetAppVersion: row.target_app_version,
    storageUri: row.storage_uri,
    fingerprintHash: row.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: row.manifest_storage_uri ?? null,
    manifestFileHash: row.manifest_file_hash ?? null,
    assetBaseStorageUri: row.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount:
      (row.rollout_cohort_count as number | null) ??
      DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: parseTargetCohorts(row.target_cohorts as unknown),
  };
}

const rowToDatabaseBundleRecord = (row: D1BundleRow): DatabaseBundleRecord =>
  toDatabaseBundleRecord(transformRowToBundle(row, []));

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

export const d1Database = createDatabasePlugin({
  name: "d1Database",
  connect: (config: D1DatabaseConfig): DatabasePluginCore => {
    const cf = new Cloudflare({
      apiToken: config.cloudflareApiToken,
    });

    const queryRows = async <TRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<TRow[]> => {
      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params: [...params] as string[],
      });
      return resolvePage<TRow>(result);
    };

    const runQuery = async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<void> => {
      await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params: [...params] as string[],
      });
    };

    const getPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, D1BundlePatchRow[]>();

      if (bundleIds.length === 0) {
        return patchMap;
      }

      const sql = minify(`
        SELECT *
        FROM bundle_patches
        WHERE bundle_id IN (SELECT value FROM json_each(?))
        ORDER BY order_index ASC, base_bundle_id ASC
      `);

      const rows = await queryRows<D1BundlePatchRow>(sql, [
        JSON.stringify(bundleIds),
      ]);

      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };

    const getBundleById = async (
      bundleId: string,
    ): Promise<DatabaseBundleRecord | null> => {
      const rows = await queryRows<D1BundleRow>(
        minify("SELECT * FROM bundles WHERE id = ? LIMIT 1"),
        [bundleId],
      );
      return rows[0] ? rowToDatabaseBundleRecord(rows[0]) : null;
    };

    const queryBundleRows = async (
      conditions: QueryConditions,
      orderBy?: DatabaseBundleQueryOrder,
    ): Promise<D1BundleRow[]> => {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const orderBySql =
        orderBy?.direction === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";
      const sql = minify(`SELECT * FROM bundles ${whereClause} ${orderBySql}`);
      return queryRows<D1BundleRow>(sql, params);
    };

    async function queryBundlesForUpdateInfo(
      conditions: QueryConditions,
    ): Promise<Bundle[]> {
      const rows = await queryBundleRows(conditions, {
        field: "id",
        direction: "desc",
      });
      const patchMap = await getPatchMap(rows.map((row) => row.id));
      return rows.map((row) => transformRowToBundle(row, patchMap.get(row.id)));
    }

    async function getTargetAppVersionsForUpdateInfo({
      platform,
      channel,
      minBundleId,
    }: {
      platform: Bundle["platform"];
      channel: string;
      minBundleId: string;
    }): Promise<string[]> {
      const sql = minify(`
        SELECT target_app_version
        FROM bundles
        WHERE channel = ?
          AND platform = ?
          AND enabled = 1
          AND id >= ?
          AND target_app_version IS NOT NULL
        GROUP BY target_app_version
      `);

      const rows = await queryRows<{ target_app_version: string }>(sql, [
        channel,
        platform,
        minBundleId,
      ]);
      return rows.map((row) => row.target_app_version);
    }

    const persistBundle = async (bundle: DatabaseBundleRecord) => {
      const row = bundleRecordToRow(bundle);
      await runQuery(
        minify(/* sql */ `
              INSERT OR REPLACE INTO bundles (
                id,
                channel,
                enabled,
                should_force_update,
                file_hash,
                git_commit_hash,
                message,
                platform,
                target_app_version,
                storage_uri,
                fingerprint_hash,
                metadata,
                manifest_storage_uri,
                manifest_file_hash,
                asset_base_storage_uri,
                rollout_cohort_count,
                target_cohorts
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
        [
          row.id,
          row.channel,
          row.enabled,
          row.should_force_update,
          row.file_hash,
          row.git_commit_hash,
          row.message,
          row.platform,
          row.target_app_version,
          row.storage_uri,
          row.fingerprint_hash,
          row.metadata,
          row.manifest_storage_uri,
          row.manifest_file_hash,
          row.asset_base_storage_uri,
          row.rollout_cohort_count,
          row.target_cohorts,
        ],
      );
    };

    const replacePatchesForBundle = async (
      bundleId: string,
      patches: readonly DatabaseBundlePatch[],
    ) => {
      await runQuery(minify("DELETE FROM bundle_patches WHERE bundle_id = ?"), [
        bundleId,
      ]);

      if (patches.length === 0) {
        return;
      }

      const patchInsertSql = minify(`
                INSERT OR REPLACE INTO bundle_patches (
                  id,
                  bundle_id,
                  base_bundle_id,
                  base_file_hash,
                  patch_file_hash,
                  patch_storage_uri,
                  order_index
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `);

      for (const patch of patches) {
        const patchRow = databaseBundlePatchToRow(patch);
        await runQuery(patchInsertSql, [
          patchRow.id,
          patchRow.bundle_id,
          patchRow.base_bundle_id,
          patchRow.base_file_hash,
          patchRow.patch_file_hash,
          patchRow.patch_storage_uri,
          patchRow.order_index ?? 0,
        ]);
      }
    };

    return {
      bundles: {
        async getById({ bundleId }) {
          return getBundleById(bundleId);
        },
        async list(options: BundleListQuery) {
          const rows = await queryBundleRows(
            options.where ?? {},
            options.orderBy,
          );
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
          await persistBundle(bundle);
        },
        async update({ bundleId, patch }) {
          const current = await getBundleById(bundleId);
          if (!current) {
            throw new Error("targetBundleId not found");
          }
          await persistBundle({ ...current, ...patch, id: bundleId });
        },
        async delete({ bundleId }) {
          await runQuery(minify("DELETE FROM bundles WHERE id = ?"), [
            bundleId,
          ]);
        },
      },
      bundlePatches: {
        async list(options: BundlePatchListQuery) {
          const rows = await queryRows<D1BundlePatchRow>(
            minify("SELECT * FROM bundle_patches ORDER BY order_index ASC"),
          );
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
              const field = options.orderBy?.field ?? "orderIndex";
              const direction = options.orderBy?.direction ?? "asc";
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
          await replacePatchesForBundle(bundleId, patches);
        },
        async deleteForBundle({ bundleId }) {
          await runQuery(
            minify("DELETE FROM bundle_patches WHERE bundle_id = ?"),
            [bundleId],
          );
        },
        async deleteForBaseBundle({ baseBundleId }) {
          await runQuery(
            minify("DELETE FROM bundle_patches WHERE base_bundle_id = ?"),
            [baseBundleId],
          );
        },
      },
      bundleEvents: {
        async list(options: BundleEventListQuery) {
          const direction = options.orderBy?.direction ?? "desc";
          const rows = await queryRows<D1BundleEventRow>(
            minify(`SELECT * FROM bundle_events ORDER BY id ${direction}`),
          );
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
          await runQuery(
            minify(`
              INSERT INTO bundle_events (
                id,
                kind,
                install_id,
                active_bundle_id,
                previous_active_bundle_id,
                crashed_bundle_id,
                platform,
                channel,
                app_version,
                fingerprint_hash,
                cohort,
                payload
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            [
              event.id,
              event.kind,
              event.installId,
              event.activeBundleId,
              event.previousActiveBundleId ?? null,
              event.crashedBundleId ?? null,
              event.platform,
              event.channel,
              event.appVersion ?? null,
              event.fingerprintHash ?? null,
              event.cohort ?? null,
              JSON.stringify(event.payload),
            ],
          );
        },
      },
      updateInfo: {
        async get(args) {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const targetAppVersions = await getTargetAppVersionsForUpdateInfo({
              platform: args.platform,
              channel,
              minBundleId,
            });
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const bundles =
              compatibleAppVersions.length > 0
                ? await queryBundlesForUpdateInfo({
                    enabled: true,
                    platform: args.platform,
                    channel,
                    id: { gte: minBundleId },
                    targetAppVersionIn: compatibleAppVersions,
                  })
                : [];

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles,
            });
          }

          const bundles = await queryBundlesForUpdateInfo({
            enabled: true,
            platform: args.platform,
            channel,
            id: { gte: minBundleId },
            fingerprintHash: args.fingerprintHash,
          });

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles,
          });
        },
      },
    };
  },
});

import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  PaginationOptions,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  createDatabasePluginGetUpdateInfo,
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
  params: any[];
}

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

async function resolvePage<T>(singlePage: any): Promise<T[]> {
  const results: T[] = [];
  for await (const page of singlePage.iterPages()) {
    const data = page.result.flatMap((r: any) => r.results);
    results.push(...(data as T[]));
  }
  return results;
}

// Helper function to build WHERE clause
function buildWhereClause(conditions: QueryConditions): BuildQueryResult {
  const clauses: string[] = [];
  const params: any[] = [];

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
    if (conditions.id.in.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`id IN (${conditions.id.in.map(() => "?").join(", ")})`);
      params.push(...conditions.id.in);
    }
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
    if (conditions.targetAppVersionIn.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(
        `target_app_version IN (${conditions.targetAppVersionIn
          .map(() => "?")
          .join(", ")})`,
      );
      params.push(...conditions.targetAppVersionIn);
    }
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

const bundleToPatchRows = (bundle: Bundle): D1BundlePatchRow[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: buildBundlePatchId(bundle.id, patch.baseBundleId),
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: index,
  }));

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

export const d1Database = createDatabasePlugin<D1DatabaseConfig>({
  name: "d1Database",
  factory: (config) => {
    const cf = new Cloudflare({
      apiToken: config.cloudflareApiToken,
    });
    const getPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, D1BundlePatchRow[]>();

      if (bundleIds.length === 0) {
        return patchMap;
      }

      const placeholders = bundleIds.map(() => "?").join(", ");
      const sql = minify(`
        SELECT *
        FROM bundle_patches
        WHERE bundle_id IN (${placeholders})
        ORDER BY order_index ASC, base_bundle_id ASC
      `);

      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params: bundleIds,
      });
      const rows = await resolvePage<D1BundlePatchRow>(result);

      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };

    // Helper function to get total count
    async function getTotalCount(conditions: QueryConditions): Promise<number> {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const countSql = minify(
        `SELECT COUNT(*) as total FROM bundles${whereClause}`,
      );

      const countResult = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql: countSql,
        params,
      });

      const rows = await resolvePage<{ total: number }>(countResult);
      return rows[0]?.total || 0;
    }

    // Helper function to get paginated bundles
    async function getPaginatedBundles(
      conditions: QueryConditions,
      limit: number,
      offset: number,
      orderBy?: DatabaseBundleQueryOrder,
    ): Promise<Bundle[]> {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const orderBySql =
        orderBy?.direction === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";

      // Build the complete query
      const sql = minify(`
      SELECT * FROM bundles
      ${whereClause}
      ${orderBySql}
      LIMIT ?
      OFFSET ?
    `);

      // Add pagination params
      params.push(limit, offset);

      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params,
      });

      const rows = await resolvePage<D1BundleRow>(result);
      const patchMap = await getPatchMap(rows.map((row) => row.id));
      return rows.map((row) => transformRowToBundle(row, patchMap.get(row.id)));
    }

    async function queryBundlesForUpdateInfo(
      conditions: QueryConditions,
    ): Promise<Bundle[]> {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const sql = minify(`
        SELECT * FROM bundles
        ${whereClause}
      `);

      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params,
      });

      const rows = await resolvePage<D1BundleRow>(result);
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

      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params: [channel, platform, minBundleId],
      });

      const rows = await resolvePage<{ target_app_version: string }>(result);
      return rows.map((row) => row.target_app_version);
    }

    return {
      getUpdateInfo: createDatabasePluginGetUpdateInfo({
        listTargetAppVersions: getTargetAppVersionsForUpdateInfo,
        getBundlesByTargetAppVersions(
          { platform, channel, minBundleId },
          targetAppVersions,
        ) {
          return queryBundlesForUpdateInfo({
            enabled: true,
            platform,
            channel,
            id: {
              gte: minBundleId,
            },
            targetAppVersionIn: targetAppVersions,
          });
        },
        getBundlesByFingerprint({
          platform,
          channel,
          minBundleId,
          fingerprintHash,
        }) {
          return queryBundlesForUpdateInfo({
            enabled: true,
            platform,
            channel,
            id: {
              gte: minBundleId,
            },
            fingerprintHash,
          });
        },
      }),

      async getBundleById(bundleId) {
        const sql = minify(/* sql */ `
          SELECT * FROM bundles WHERE id = ? LIMIT 1`);
        const [singlePage, patchMap] = await Promise.all([
          cf.d1.database.query(config.databaseId, {
            account_id: config.accountId,
            sql,
            params: [bundleId],
          }),
          getPatchMap([bundleId]),
        ]);

        const rows = await resolvePage<D1BundleRow>(singlePage);

        if (rows.length === 0) {
          return null;
        }

        return transformRowToBundle(rows[0], patchMap.get(bundleId));
      },

      async getBundles(options) {
        const { where = {}, limit, orderBy } = options;
        const offset =
          (("offset" in options ? options.offset : undefined) as
            | number
            | undefined) ?? 0;

        // 1. Get total count for pagination
        const totalCount = await getTotalCount(where);

        // 2. Get paginated bundles
        const bundles = await getPaginatedBundles(
          where,
          limit,
          offset,
          orderBy,
        );

        // 3. Calculate pagination metadata
        const paginationOptions: PaginationOptions = { limit, offset };
        const pagination = calculatePagination(totalCount, paginationOptions);

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels() {
        const sql = minify(/* sql */ `
          SELECT channel FROM bundles GROUP BY channel
        `);
        const singlePage = await cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: [],
        });

        const rows = await resolvePage<{ channel: string }>(singlePage);
        return rows.map((row) => row.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const deleteSql = minify(/* sql */ `
              DELETE FROM bundles WHERE id = ?
            `);

            const deletePatchSql = minify(/* sql */ `
              DELETE FROM bundle_patches WHERE bundle_id = ?
            `);
            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: deletePatchSql,
              params: [op.data.id],
            });

            const deleteBasePatchSql = minify(/* sql */ `
              DELETE FROM bundle_patches WHERE base_bundle_id = ?
            `);
            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: deleteBasePatchSql,
              params: [op.data.id],
            });

            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: deleteSql,
              params: [op.data.id],
            });
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const bundle = op.data;
            const upsertSql = minify(/* sql */ `
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
            `);

            const params = [
              bundle.id,
              bundle.channel,
              bundle.enabled ? 1 : 0,
              bundle.shouldForceUpdate ? 1 : 0,
              bundle.fileHash,
              bundle.gitCommitHash || null,
              bundle.message || null,
              bundle.platform,
              bundle.targetAppVersion,
              bundle.storageUri,
              bundle.fingerprintHash,
              JSON.stringify(
                stripBundleArtifactMetadata(bundle.metadata) ?? {},
              ),
              getManifestStorageUri(bundle),
              getManifestFileHash(bundle),
              getAssetBaseStorageUri(bundle),
              bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
              bundle.targetCohorts
                ? JSON.stringify(bundle.targetCohorts)
                : null,
            ];

            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: upsertSql,
              params: params as string[],
            });

            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: minify(`
                DELETE FROM bundle_patches WHERE bundle_id = ?
              `),
              params: [bundle.id],
            });

            const patchRows = bundleToPatchRows(bundle);
            if (patchRows.length > 0) {
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

              for (const patchRow of patchRows) {
                await cf.d1.database.query(config.databaseId, {
                  account_id: config.accountId,
                  sql: patchInsertSql,
                  params: [
                    patchRow.id,
                    patchRow.bundle_id,
                    patchRow.base_bundle_id,
                    patchRow.base_file_hash,
                    patchRow.patch_file_hash,
                    patchRow.patch_storage_uri,
                    String(patchRow.order_index ?? 0),
                  ],
                });
              }
            }
          }
        }
      },
    };
  },
});

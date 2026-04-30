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
  DatabaseBundleQueryWhere,
  HotUpdaterContext,
  PaginationOptions,
  RequestEnvContext,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  createDatabasePluginGetUpdateInfo,
} from "@hot-updater/plugin-core";

type D1Result<T> = {
  results?: T[];
};

type D1PreparedStatement = {
  bind: (...values: unknown[]) => {
    all: <T>() => Promise<D1Result<T>>;
    first: <T>() => Promise<T | null>;
    run: () => Promise<unknown>;
  };
};

type D1Like = {
  prepare: (sql: string) => D1PreparedStatement;
};

export interface CloudflareWorkerDatabaseEnv {
  DB: D1Like;
}

interface CloudflareWorkerDatabaseConfig<
  TContext extends RequestEnvContext<CloudflareWorkerDatabaseEnv>,
> {
  getDb: (context?: HotUpdaterContext<TContext>) => D1Like;
}

type QueryConditions = DatabaseBundleQueryWhere;

interface BuildQueryResult {
  sql: string;
  params: unknown[];
}

interface D1WorkerBundleRow {
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

interface D1WorkerBundlePatchRow {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number | null;
}

function buildWhereClause(
  conditions: QueryConditions | undefined,
): BuildQueryResult {
  if (!conditions) {
    return { sql: "", params: [] };
  }

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
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
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

const bundleToPatchRows = (bundle: Bundle): D1WorkerBundlePatchRow[] =>
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
  row: D1WorkerBundleRow,
  patchRows: D1WorkerBundlePatchRow[] = [],
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
    manifestStorageUri:
      row.manifest_storage_uri ??
      getManifestStorageUri({ metadata: rawMetadata }),
    manifestFileHash:
      row.manifest_file_hash ?? getManifestFileHash({ metadata: rawMetadata }),
    assetBaseStorageUri:
      row.asset_base_storage_uri ??
      getAssetBaseStorageUri({ metadata: rawMetadata }),
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

const resolveDbFromContext = (
  context?: RequestEnvContext<CloudflareWorkerDatabaseEnv>,
) => {
  const db = context?.env?.DB;

  if (!db) {
    throw new Error(
      "d1WorkerDatabase requires env.DB in the hot updater context.",
    );
  }

  return db;
};

export const d1WorkerDatabase = <
  TContext extends RequestEnvContext<CloudflareWorkerDatabaseEnv> =
    RequestEnvContext<CloudflareWorkerDatabaseEnv>,
>() =>
  createDatabasePlugin<CloudflareWorkerDatabaseConfig<TContext>, TContext>({
    name: "d1WorkerDatabase",
    factory: (config) => {
      const queryAll = async <TRow>(
        sql: string,
        params: unknown[] = [],
        context?: HotUpdaterContext<TContext>,
      ): Promise<TRow[]> => {
        const result = await config
          .getDb(context)
          .prepare(sql)
          .bind(...params)
          .all<TRow>();
        return result.results ?? [];
      };

      const queryFirst = async <TRow>(
        sql: string,
        params: unknown[] = [],
        context?: HotUpdaterContext<TContext>,
      ): Promise<TRow | null> => {
        const result = await config
          .getDb(context)
          .prepare(sql)
          .bind(...params)
          .first<TRow>();
        return result ?? null;
      };

      const getPatchMap = async (
        bundleIds: string[],
        context?: HotUpdaterContext<TContext>,
      ) => {
        const patchMap = new Map<string, D1WorkerBundlePatchRow[]>();

        if (bundleIds.length === 0) {
          return patchMap;
        }

        const placeholders = bundleIds.map(() => "?").join(", ");
        const rows = await queryAll<D1WorkerBundlePatchRow>(
          `
            SELECT *
            FROM bundle_patches
            WHERE bundle_id IN (${placeholders})
            ORDER BY order_index ASC, base_bundle_id ASC
          `,
          bundleIds,
          context,
        );

        for (const row of rows) {
          const current = patchMap.get(row.bundle_id) ?? [];
          current.push(row);
          patchMap.set(row.bundle_id, current);
        }

        return patchMap;
      };

      const queryBundlesForUpdateInfo = async (
        conditions: QueryConditions,
        context?: HotUpdaterContext<TContext>,
      ): Promise<Bundle[]> => {
        const { sql: whereClause, params } = buildWhereClause(conditions);
        const rows = await queryAll<D1WorkerBundleRow>(
          `
            SELECT * FROM bundles
            ${whereClause}
          `,
          params,
          context,
        );
        const patchMap = await getPatchMap(
          rows.map((row) => row.id),
          context,
        );

        return rows.map((row) =>
          transformRowToBundle(row, patchMap.get(row.id)),
        );
      };

      const getTargetAppVersionsForUpdateInfo = async (
        {
          platform,
          channel,
          minBundleId,
        }: {
          platform: Bundle["platform"];
          channel: string;
          minBundleId: string;
        },
        context?: HotUpdaterContext<TContext>,
      ): Promise<string[]> => {
        const rows = await queryAll<{ target_app_version: string }>(
          `
            SELECT target_app_version
            FROM bundles
            WHERE channel = ?
              AND platform = ?
              AND enabled = 1
              AND id >= ?
              AND target_app_version IS NOT NULL
            GROUP BY target_app_version
          `,
          [channel, platform, minBundleId],
          context,
        );

        return rows.map((row) => row.target_app_version);
      };

      return {
        getUpdateInfo: createDatabasePluginGetUpdateInfo({
          listTargetAppVersions: getTargetAppVersionsForUpdateInfo,
          getBundlesByTargetAppVersions(
            { platform, channel, minBundleId },
            targetAppVersions,
            context,
          ) {
            return queryBundlesForUpdateInfo(
              {
                enabled: true,
                platform,
                channel,
                id: {
                  gte: minBundleId,
                },
                targetAppVersionIn: targetAppVersions,
              },
              context,
            );
          },
          getBundlesByFingerprint(
            { platform, channel, minBundleId, fingerprintHash },
            context,
          ) {
            return queryBundlesForUpdateInfo(
              {
                enabled: true,
                platform,
                channel,
                id: {
                  gte: minBundleId,
                },
                fingerprintHash,
              },
              context,
            );
          },
        }),

        async getBundleById(bundleId, context) {
          const [row, patchMap] = await Promise.all([
            queryFirst<D1WorkerBundleRow>(
              "SELECT * FROM bundles WHERE id = ? LIMIT 1",
              [bundleId],
              context,
            ),
            getPatchMap([bundleId], context),
          ]);

          return row ? transformRowToBundle(row, patchMap.get(bundleId)) : null;
        },

        async getBundles(options, context) {
          const { where, limit, orderBy } = options;
          const offset =
            (("offset" in options ? options.offset : undefined) as
              | number
              | undefined) ?? 0;
          const { sql: whereClause, params } = buildWhereClause(where);
          const orderSql =
            orderBy?.direction === "asc"
              ? "ORDER BY id ASC"
              : "ORDER BY id DESC";

          const countRows = await queryAll<{ total: number }>(
            `SELECT COUNT(*) as total FROM bundles${whereClause}`,
            params,
            context,
          );
          const total = countRows[0]?.total ?? 0;

          const rows = await queryAll<D1WorkerBundleRow>(
            `SELECT * FROM bundles${whereClause} ${orderSql} LIMIT ? OFFSET ?`,
            [...params, limit, offset],
            context,
          );

          const patchMap = await getPatchMap(
            rows.map((row) => row.id),
            context,
          );
          const bundles = rows.map((row) =>
            transformRowToBundle(row, patchMap.get(row.id)),
          );

          const paginationOptions: PaginationOptions = { limit, offset };
          return {
            data: bundles,
            pagination: calculatePagination(total, paginationOptions),
          };
        },

        async getChannels(context) {
          const rows = await queryAll<{ channel: string }>(
            "SELECT channel FROM bundles GROUP BY channel",
            [],
            context,
          );
          return rows.map((row) => row.channel);
        },

        async commitBundle({ changedSets }, context) {
          if (changedSets.length === 0) {
            return;
          }

          const db = config.getDb(context);

          for (const operation of changedSets) {
            if (operation.operation === "delete") {
              await db
                .prepare("DELETE FROM bundle_patches WHERE bundle_id = ?")
                .bind(operation.data.id)
                .run();
              await db
                .prepare("DELETE FROM bundle_patches WHERE base_bundle_id = ?")
                .bind(operation.data.id)
                .run();
              await db
                .prepare("DELETE FROM bundles WHERE id = ?")
                .bind(operation.data.id)
                .run();
              continue;
            }

            const bundle = operation.data;
            await db
              .prepare(`
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
              `)
              .bind(
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
              )
              .run();

            await db
              .prepare("DELETE FROM bundle_patches WHERE bundle_id = ?")
              .bind(bundle.id)
              .run();

            const patchRows = bundleToPatchRows(bundle);
            for (const patchRow of patchRows) {
              await db
                .prepare(`
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
                `)
                .bind(
                  patchRow.id,
                  patchRow.bundle_id,
                  patchRow.base_bundle_id,
                  patchRow.base_file_hash,
                  patchRow.patch_file_hash,
                  patchRow.patch_storage_uri,
                  patchRow.order_index ?? 0,
                )
                .run();
            }
          }
        },
      };
    },
  })({
    getDb: resolveDbFromContext,
  });

import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  type SnakeCaseBundle,
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

function transformRowToBundle(row: SnakeCaseBundle): Bundle {
  const rawMetadata = parseMetadata(row.metadata);
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
    patchBaseBundleId:
      row.patch_base_bundle_id ??
      getPatchBaseBundleId({ metadata: rawMetadata }),
    patchBaseFileHash:
      row.patch_base_file_hash ??
      getPatchBaseFileHash({ metadata: rawMetadata }),
    patchFileHash:
      row.patch_file_hash ?? getPatchFileHash({ metadata: rawMetadata }),
    patchStorageUri:
      row.patch_storage_uri ?? getPatchStorageUri({ metadata: rawMetadata }),
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

      const queryBundlesForUpdateInfo = async (
        conditions: QueryConditions,
        context?: HotUpdaterContext<TContext>,
      ): Promise<Bundle[]> => {
        const { sql: whereClause, params } = buildWhereClause(conditions);
        const rows = await queryAll<SnakeCaseBundle>(
          `
            SELECT * FROM bundles
            ${whereClause}
          `,
          params,
          context,
        );

        return rows.map(transformRowToBundle);
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
          const row = await queryFirst<SnakeCaseBundle>(
            "SELECT * FROM bundles WHERE id = ? LIMIT 1",
            [bundleId],
            context,
          );

          return row ? transformRowToBundle(row) : null;
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

          const rows = await queryAll<SnakeCaseBundle>(
            `SELECT * FROM bundles${whereClause} ${orderSql} LIMIT ? OFFSET ?`,
            [...params, limit, offset],
            context,
          );

          const bundles = rows.map(transformRowToBundle);

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
                  patch_base_bundle_id,
                  patch_base_file_hash,
                  patch_file_hash,
                  patch_storage_uri,
                  rollout_cohort_count,
                  target_cohorts
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                getPatchBaseBundleId(bundle),
                getPatchBaseFileHash(bundle),
                getPatchFileHash(bundle),
                getPatchStorageUri(bundle),
                bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                bundle.targetCohorts
                  ? JSON.stringify(bundle.targetCohorts)
                  : null,
              )
              .run();
          }
        },
      };
    },
  })({
    getDb: resolveDbFromContext,
  });

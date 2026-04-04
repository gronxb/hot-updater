import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  isCohortEligibleForUpdate,
  NIL_UUID,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";
import { semverSatisfies } from "@hot-updater/plugin-core";
import type { InferFumaDB } from "fumadb";
import { fumadb } from "fumadb";
import type { FumaDBAdapter } from "fumadb/adapters";

import { calculatePagination } from "../calculatePagination";
import { v0_21_0 } from "../schema/v0_21_0";
import { v0_29_0 } from "../schema/v0_29_0";
import type { Paginated } from "../types";
import type { DatabaseAPI } from "./types";

const parseTargetCohorts = (value: unknown): string[] | null => {
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
};

const schemas: [typeof v0_21_0, typeof v0_29_0] = [v0_21_0, v0_29_0];

const getLastItem = <T extends unknown[]>(
  items: T,
): T extends [...infer _, infer Last] ? Last : never =>
  items.at(-1) as T extends [...infer _, infer Last] ? Last : never;

export const HotUpdaterDB = fumadb({
  namespace: "hot_updater",
  schemas,
});
export type HotUpdaterClient = InferFumaDB<typeof HotUpdaterDB>;

export type Migrator = ReturnType<HotUpdaterClient["createMigrator"]>;

export function createOrmDatabaseCore<TContext = unknown>({
  database,
  resolveFileUrl,
}: {
  database: FumaDBAdapter;
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>;
}): {
  api: DatabaseAPI<TContext>;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
} {
  const client = HotUpdaterDB.client(database);
  const UPDATE_CHECK_PAGE_SIZE = 100;
  const isMongoAdapter = client.adapter.name.toLowerCase().includes("mongodb");

  const ensureORM = async () => {
    const latestSchema = getLastItem(schemas);
    const lastSchemaVersion = latestSchema.version;

    try {
      const migrator = client.createMigrator();
      const currentVersion = await migrator.getVersion();

      if (currentVersion === undefined) {
        throw new Error(
          "Database is not initialized. Please run 'npx hot-updater migrate' to set up the database schema.",
        );
      }

      if (currentVersion !== lastSchemaVersion) {
        throw new Error(
          `Database schema version mismatch. Expected version ${lastSchemaVersion}, but database is on version ${currentVersion}. ` +
            "Please run 'npx hot-updater migrate' to update your database schema.",
        );
      }

      return client.orm(lastSchemaVersion);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("doesn't support migration")
      ) {
        return client.orm(lastSchemaVersion);
      }
      throw error;
    }
  };

  const buildBundleWhere = (where?: DatabaseBundleQueryWhere) => (b: any) => {
    if (where?.id?.in && where.id.in.length === 0) {
      return false;
    }

    if (where?.targetAppVersionIn && where.targetAppVersionIn.length === 0) {
      return false;
    }

    const conditions = [];

    if (where?.channel !== undefined) {
      conditions.push(b("channel", "=", where.channel));
    }
    if (where?.platform !== undefined) {
      conditions.push(b("platform", "=", where.platform));
    }
    if (where?.enabled !== undefined) {
      conditions.push(b("enabled", "=", where.enabled));
    }
    if (where?.id?.eq !== undefined) {
      conditions.push(b("id", "=", where.id.eq));
    }
    if (where?.id?.gt !== undefined) {
      conditions.push(b("id", ">", where.id.gt));
    }
    if (where?.id?.gte !== undefined) {
      conditions.push(b("id", ">=", where.id.gte));
    }
    if (where?.id?.lt !== undefined) {
      conditions.push(b("id", "<", where.id.lt));
    }
    if (where?.id?.lte !== undefined) {
      conditions.push(b("id", "<=", where.id.lte));
    }
    if (where?.id?.in) {
      conditions.push(b("id", "in", where.id.in));
    }
    if (where?.targetAppVersionNotNull) {
      conditions.push(b.isNotNull("target_app_version"));
    }
    if (where?.targetAppVersion !== undefined) {
      conditions.push(
        where.targetAppVersion === null
          ? b.isNull("target_app_version")
          : b("target_app_version", "=", where.targetAppVersion),
      );
    }
    if (where?.targetAppVersionIn) {
      conditions.push(b("target_app_version", "in", where.targetAppVersionIn));
    }
    if (where?.fingerprintHash !== undefined) {
      conditions.push(
        where.fingerprintHash === null
          ? b.isNull("fingerprint_hash")
          : b("fingerprint_hash", "=", where.fingerprintHash),
      );
    }

    return conditions.length > 0 ? b.and(...conditions) : true;
  };

  const api: DatabaseAPI<TContext> = {
    async getBundleById(id: string): Promise<Bundle | null> {
      const orm = await ensureORM();
      const result = await orm.findFirst("bundles", {
        select: [
          "id",
          "platform",
          "should_force_update",
          "enabled",
          "file_hash",
          "git_commit_hash",
          "message",
          "channel",
          "storage_uri",
          "target_app_version",
          "fingerprint_hash",
          "metadata",
          "rollout_cohort_count",
          "target_cohorts",
        ],
        where: (b) => b("id", "=", id),
      });
      if (!result) return null;
      const bundle: Bundle = {
        id: result.id,
        platform: result.platform as Platform,
        shouldForceUpdate: Boolean(result.should_force_update),
        enabled: Boolean(result.enabled),
        fileHash: result.file_hash,
        gitCommitHash: result.git_commit_hash ?? null,
        message: result.message ?? null,
        channel: result.channel,
        storageUri: result.storage_uri,
        targetAppVersion: result.target_app_version ?? null,
        fingerprintHash: result.fingerprint_hash ?? null,
        rolloutCohortCount:
          result.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
        targetCohorts: parseTargetCohorts(result.target_cohorts),
      };
      return bundle;
    },

    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      const orm = await ensureORM();

      type UpdateSelectRow = {
        id: string;
        should_force_update: boolean;
        message: string | null;
        storage_uri: string | null;
        file_hash: string;
        rollout_cohort_count?: number | null;
        target_cohorts?: unknown | null;
        target_app_version?: string | null;
        fingerprint_hash?: string | null;
      };

      const toUpdateInfo = (
        row: UpdateSelectRow,
        status: "UPDATE" | "ROLLBACK",
      ): UpdateInfo => ({
        id: row.id,
        shouldForceUpdate:
          status === "ROLLBACK" ? true : Boolean(row.should_force_update),
        message: row.message ?? null,
        status,
        storageUri: row.storage_uri ?? null,
        fileHash: row.file_hash ?? null,
      });

      const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: null,
        fileHash: null,
      };

      const isEligibleForUpdate = (
        row: UpdateSelectRow,
        cohort: string | undefined,
      ): boolean => {
        return isCohortEligibleForUpdate(
          row.id,
          cohort,
          row.rollout_cohort_count ?? null,
          parseTargetCohorts(row.target_cohorts),
        );
      };

      const findUpdateInfoByScanning = async ({
        args,
        where,
        isCandidate,
      }: {
        args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs;
        where: DatabaseBundleQueryWhere;
        isCandidate: (row: UpdateSelectRow) => boolean;
      }): Promise<UpdateInfo | null> => {
        if (isMongoAdapter) {
          const rows = await orm.findMany("bundles", {
            select: [
              "id",
              "should_force_update",
              "message",
              "storage_uri",
              "file_hash",
              "rollout_cohort_count",
              "target_cohorts",
              "target_app_version",
              "fingerprint_hash",
            ],
            where: buildBundleWhere(where),
          });

          rows.sort((a, b) => b.id.localeCompare(a.id));

          for (const row of rows) {
            if (!isCandidate(row)) {
              continue;
            }

            if (args.bundleId === NIL_UUID) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return toUpdateInfo(row, "UPDATE");
              }
              continue;
            }

            const compareResult = row.id.localeCompare(args.bundleId);

            if (compareResult > 0) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return toUpdateInfo(row, "UPDATE");
              }
              continue;
            }

            if (compareResult === 0) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return null;
              }
              continue;
            }

            return toUpdateInfo(row, "ROLLBACK");
          }

          if (args.bundleId === NIL_UUID) {
            return null;
          }

          if (
            args.minBundleId &&
            args.bundleId.localeCompare(args.minBundleId) <= 0
          ) {
            return null;
          }

          return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
        }

        let offset = 0;

        while (true) {
          const rows = await orm.findMany("bundles", {
            select: [
              "id",
              "should_force_update",
              "message",
              "storage_uri",
              "file_hash",
              "rollout_cohort_count",
              "target_cohorts",
              "target_app_version",
              "fingerprint_hash",
            ],
            where: buildBundleWhere(where),
            orderBy: [["id", "desc"]],
            limit: UPDATE_CHECK_PAGE_SIZE,
            offset,
          });

          for (const row of rows) {
            if (!isCandidate(row)) {
              continue;
            }

            if (args.bundleId === NIL_UUID) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return toUpdateInfo(row, "UPDATE");
              }
              continue;
            }

            const compareResult = row.id.localeCompare(args.bundleId);

            if (compareResult > 0) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return toUpdateInfo(row, "UPDATE");
              }
              continue;
            }

            if (compareResult === 0) {
              if (isEligibleForUpdate(row, args.cohort)) {
                return null;
              }
              continue;
            }

            return toUpdateInfo(row, "ROLLBACK");
          }

          if (rows.length < UPDATE_CHECK_PAGE_SIZE) {
            break;
          }

          offset += UPDATE_CHECK_PAGE_SIZE;
        }

        if (args.bundleId === NIL_UUID) {
          return null;
        }

        if (
          args.minBundleId &&
          args.bundleId.localeCompare(args.minBundleId) <= 0
        ) {
          return null;
        }

        return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
      };

      const appVersionStrategy = async ({
        platform,
        appVersion,
        bundleId,
        minBundleId = NIL_UUID,
        channel = "production",
        cohort,
      }: AppVersionGetBundlesArgs): Promise<UpdateInfo | null> => {
        return findUpdateInfoByScanning({
          args: {
            _updateStrategy: "appVersion",
            platform,
            appVersion,
            bundleId,
            minBundleId,
            channel,
            cohort,
          },
          where: {
            enabled: true,
            platform,
            channel,
            id: {
              gte: minBundleId,
            },
            targetAppVersionNotNull: true,
          },
          isCandidate: (row) =>
            !!row.target_app_version &&
            semverSatisfies(row.target_app_version, appVersion),
        });
      };

      const fingerprintStrategy = async ({
        platform,
        fingerprintHash,
        bundleId,
        minBundleId = NIL_UUID,
        channel = "production",
        cohort,
      }: FingerprintGetBundlesArgs): Promise<UpdateInfo | null> => {
        return findUpdateInfoByScanning({
          args: {
            _updateStrategy: "fingerprint",
            platform,
            fingerprintHash,
            bundleId,
            minBundleId,
            channel,
            cohort,
          },
          where: {
            enabled: true,
            platform,
            channel,
            id: {
              gte: minBundleId,
            },
            fingerprintHash,
          },
          isCandidate: (row) => row.fingerprint_hash === fingerprintHash,
        });
      };

      if (args._updateStrategy === "appVersion") {
        return appVersionStrategy(args);
      }
      if (args._updateStrategy === "fingerprint") {
        return fingerprintStrategy(args);
      }
      return null;
    },

    async getAppUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<AppUpdateInfo | null> {
      const info = await this.getUpdateInfo(args);
      if (!info) return null;
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };
      const fileUrl = await resolveFileUrl(storageUri ?? null, context);
      return { ...rest, fileUrl };
    },

    async getChannels(): Promise<string[]> {
      const orm = await ensureORM();
      const rows = await orm.findMany("bundles", {
        select: ["channel"],
        orderBy: [["channel", "asc"]],
      });
      const set = new Set(rows?.map((r) => r.channel) ?? []);
      return Array.from(set);
    },

    async getBundles(
      options: DatabaseBundleQueryOptions,
    ): Promise<Paginated<Bundle[]>> {
      const orm = await ensureORM();
      const { where, limit, offset, orderBy } = options;

      const total = await orm.count("bundles", {
        where: buildBundleWhere(where),
      });

      const selectedColumns: Array<
        | "id"
        | "platform"
        | "should_force_update"
        | "enabled"
        | "file_hash"
        | "git_commit_hash"
        | "message"
        | "channel"
        | "storage_uri"
        | "target_app_version"
        | "fingerprint_hash"
        | "metadata"
        | "rollout_cohort_count"
        | "target_cohorts"
      > = [
        "id",
        "platform",
        "should_force_update",
        "enabled",
        "file_hash",
        "git_commit_hash",
        "message",
        "channel",
        "storage_uri",
        "target_app_version",
        "fingerprint_hash",
        "metadata",
        "rollout_cohort_count",
        "target_cohorts",
      ];

      const rows = isMongoAdapter
        ? (
            await orm.findMany("bundles", {
              select: selectedColumns,
              where: buildBundleWhere(where),
            })
          )
            .sort((a, b) => {
              const direction = orderBy?.direction ?? "desc";
              const result = a.id.localeCompare(b.id);
              return direction === "asc" ? result : -result;
            })
            .slice(offset, offset + limit)
        : await orm.findMany("bundles", {
            select: selectedColumns,
            where: buildBundleWhere(where),
            orderBy: [[orderBy?.field ?? "id", orderBy?.direction ?? "desc"]],
            limit,
            offset,
          });

      const data: Bundle[] = rows.map(
        (r): Bundle => ({
          id: r.id,
          platform: r.platform as Platform,
          shouldForceUpdate: Boolean(r.should_force_update),
          enabled: Boolean(r.enabled),
          fileHash: r.file_hash,
          gitCommitHash: r.git_commit_hash ?? null,
          message: r.message ?? null,
          channel: r.channel,
          storageUri: r.storage_uri,
          targetAppVersion: r.target_app_version ?? null,
          fingerprintHash: r.fingerprint_hash ?? null,
          rolloutCohortCount:
            r.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
          targetCohorts: parseTargetCohorts(r.target_cohorts),
        }),
      );

      return {
        data,
        pagination: calculatePagination(total, { limit, offset }),
      };
    },

    async insertBundle(bundle: Bundle): Promise<void> {
      const orm = await ensureORM();
      const values = {
        id: bundle.id,
        platform: bundle.platform,
        should_force_update: bundle.shouldForceUpdate,
        enabled: bundle.enabled,
        file_hash: bundle.fileHash,
        git_commit_hash: bundle.gitCommitHash,
        message: bundle.message,
        channel: bundle.channel,
        storage_uri: bundle.storageUri,
        target_app_version: bundle.targetAppVersion,
        fingerprint_hash: bundle.fingerprintHash,
        metadata: bundle.metadata ?? {},
        rollout_cohort_count:
          bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
        target_cohorts: bundle.targetCohorts ?? null,
      };
      const { id, ...updateValues } = values;
      await orm.upsert("bundles", {
        where: (b) => b("id", "=", id),
        create: values,
        update: updateValues,
      });
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
    ): Promise<void> {
      const orm = await ensureORM();
      const current = await this.getBundleById(bundleId);
      if (!current) throw new Error("targetBundleId not found");
      const merged: Bundle = { ...current, ...newBundle };
      const values = {
        id: merged.id,
        platform: merged.platform,
        should_force_update: merged.shouldForceUpdate,
        enabled: merged.enabled,
        file_hash: merged.fileHash,
        git_commit_hash: merged.gitCommitHash,
        message: merged.message,
        channel: merged.channel,
        storage_uri: merged.storageUri,
        target_app_version: merged.targetAppVersion,
        fingerprint_hash: merged.fingerprintHash,
        metadata: merged.metadata ?? {},
        rollout_cohort_count:
          merged.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
        target_cohorts: merged.targetCohorts ?? null,
      };
      const { id: id2, ...updateValues2 } = values;
      await orm.upsert("bundles", {
        where: (b) => b("id", "=", id2),
        create: values,
        update: updateValues2,
      });
    },

    async deleteBundleById(bundleId: string): Promise<void> {
      const orm = await ensureORM();
      await orm.deleteMany("bundles", { where: (b) => b("id", "=", bundleId) });
    },
  };

  return {
    api,
    adapterName: client.adapter.name,
    createMigrator: () => client.createMigrator(),
    generateSchema: client.generateSchema,
  };
}

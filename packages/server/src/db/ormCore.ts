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
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  DEFAULT_ROLLOUT_COHORT_COUNT,
  isCohortEligibleForUpdate,
  NIL_UUID,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  DatabaseBundleCursor,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOrder,
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
import { v0_31_0 } from "../schema/v0_31_0";
import type { Paginated } from "../types";
import type { DatabaseAPI } from "./types";
import {
  parseBundleMetadata,
  parseBundleRawMetadata,
  resolveManifestArtifacts,
} from "./updateArtifacts";

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

const schemas: [typeof v0_21_0, typeof v0_29_0, typeof v0_31_0] = [
  v0_21_0,
  v0_29_0,
  v0_31_0,
];

const getLastItem = <T extends unknown[]>(
  items: T,
): T extends [...infer _, infer Last] ? Last : never =>
  items.at(-1) as T extends [...infer _, infer Last] ? Last : never;

const DEFAULT_BUNDLE_ORDER = { field: "id", direction: "desc" } as const;

const mergeIdFilter = (
  base: DatabaseBundleIdFilter | undefined,
  patch: DatabaseBundleIdFilter,
): DatabaseBundleIdFilter => ({
  ...base,
  ...patch,
});

const mergeWhereWithIdFilter = (
  where: DatabaseBundleQueryWhere | undefined,
  idFilter: DatabaseBundleIdFilter,
): DatabaseBundleQueryWhere => ({
  ...where,
  id: mergeIdFilter(where?.id, idFilter),
});

const buildCursorPageWhere = (
  where: DatabaseBundleQueryWhere | undefined,
  cursor: DatabaseBundleCursor,
  orderBy: DatabaseBundleQueryOrder,
): {
  reverseData: boolean;
  where: DatabaseBundleQueryWhere;
  orderBy: DatabaseBundleQueryOrder;
} => {
  const direction = orderBy.direction;

  if (cursor.after) {
    return {
      reverseData: false,
      where: mergeWhereWithIdFilter(where, {
        [direction === "desc" ? "lt" : "gt"]: cursor.after,
      }),
      orderBy,
    };
  }

  if (cursor.before) {
    return {
      reverseData: true,
      where: mergeWhereWithIdFilter(where, {
        [direction === "desc" ? "gt" : "lt"]: cursor.before,
      }),
      orderBy: {
        field: orderBy.field,
        direction: direction === "desc" ? "asc" : "desc",
      },
    };
  }

  return {
    reverseData: false,
    where: where ?? {},
    orderBy,
  };
};

const buildCountBeforeWhere = (
  where: DatabaseBundleQueryWhere | undefined,
  firstBundleId: string,
  orderBy: DatabaseBundleQueryOrder,
): DatabaseBundleQueryWhere =>
  mergeWhereWithIdFilter(where, {
    [orderBy.direction === "desc" ? "gt" : "lt"]: firstBundleId,
  });

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

  const mapBundleRecordToBundle = (record: {
    id: string;
    platform: string;
    should_force_update: unknown;
    enabled: unknown;
    file_hash: string;
    git_commit_hash: string | null;
    message: string | null;
    channel: string;
    storage_uri: string;
    target_app_version: string | null;
    fingerprint_hash: string | null;
    metadata?: unknown;
    manifest_storage_uri?: string | null;
    manifest_file_hash?: string | null;
    asset_base_storage_uri?: string | null;
    patch_base_bundle_id?: string | null;
    patch_base_file_hash?: string | null;
    patch_file_hash?: string | null;
    patch_storage_uri?: string | null;
    rollout_cohort_count?: number | null;
    target_cohorts?: unknown;
  }): Bundle => {
    const rawMetadata = parseBundleRawMetadata(record.metadata);
    return {
      id: record.id,
      platform: record.platform as Platform,
      shouldForceUpdate: Boolean(record.should_force_update),
      enabled: Boolean(record.enabled),
      fileHash: record.file_hash,
      gitCommitHash: record.git_commit_hash ?? null,
      message: record.message ?? null,
      channel: record.channel,
      storageUri: record.storage_uri,
      targetAppVersion: record.target_app_version ?? null,
      fingerprintHash: record.fingerprint_hash ?? null,
      metadata: parseBundleMetadata(record.metadata),
      manifestStorageUri:
        record.manifest_storage_uri ??
        getManifestStorageUri({ metadata: rawMetadata }),
      manifestFileHash:
        record.manifest_file_hash ??
        getManifestFileHash({ metadata: rawMetadata }),
      assetBaseStorageUri:
        record.asset_base_storage_uri ??
        getAssetBaseStorageUri({ metadata: rawMetadata }),
      patchBaseBundleId:
        record.patch_base_bundle_id ??
        getPatchBaseBundleId({ metadata: rawMetadata }),
      patchBaseFileHash:
        record.patch_base_file_hash ??
        getPatchBaseFileHash({ metadata: rawMetadata }),
      patchFileHash:
        record.patch_file_hash ?? getPatchFileHash({ metadata: rawMetadata }),
      patchStorageUri:
        record.patch_storage_uri ??
        getPatchStorageUri({ metadata: rawMetadata }),
      rolloutCohortCount:
        record.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
      targetCohorts: parseTargetCohorts(record.target_cohorts),
    };
  };

  const fetchBundleById = async (id: string): Promise<Bundle | null> => {
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
        "manifest_storage_uri",
        "manifest_file_hash",
        "asset_base_storage_uri",
        "patch_base_bundle_id",
        "patch_base_file_hash",
        "patch_file_hash",
        "patch_storage_uri",
        "rollout_cohort_count",
        "target_cohorts",
      ],
      where: (b) => b("id", "=", id),
    });

    return result ? mapBundleRecordToBundle(result) : null;
  };

  const api: DatabaseAPI<TContext> = {
    async getBundleById(id: string): Promise<Bundle | null> {
      return fetchBundleById(id);
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
      const baseResponse = { ...rest, fileUrl };

      try {
        const currentBundle =
          args.bundleId !== NIL_UUID
            ? await fetchBundleById(args.bundleId)
            : null;
        const targetBundle =
          info.id !== NIL_UUID ? await fetchBundleById(info.id) : null;
        const manifestArtifacts = await resolveManifestArtifacts({
          currentBundle,
          resolveFileUrl,
          targetBundle,
          context,
        });

        if (!manifestArtifacts) {
          return baseResponse;
        }

        return {
          ...baseResponse,
          ...manifestArtifacts,
        };
      } catch {
        return baseResponse;
      }
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
      const { where, limit } = options;
      const orderBy = options.orderBy ?? DEFAULT_BUNDLE_ORDER;
      const offset =
        (("offset" in options ? options.offset : undefined) as
          | number
          | undefined) ?? 0;

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
        | "manifest_storage_uri"
        | "manifest_file_hash"
        | "asset_base_storage_uri"
        | "patch_base_bundle_id"
        | "patch_base_file_hash"
        | "patch_file_hash"
        | "patch_storage_uri"
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
        "manifest_storage_uri",
        "manifest_file_hash",
        "asset_base_storage_uri",
        "patch_base_bundle_id",
        "patch_base_file_hash",
        "patch_file_hash",
        "patch_storage_uri",
        "rollout_cohort_count",
        "target_cohorts",
      ];

      const findBundles = async ({
        where,
        orderBy,
        limit,
        offset,
      }: {
        where?: DatabaseBundleQueryWhere;
        orderBy: DatabaseBundleQueryOrder;
        limit: number;
        offset: number;
      }) => {
        const rows = isMongoAdapter
          ? (
              await orm.findMany("bundles", {
                select: selectedColumns,
                where: buildBundleWhere(where),
              })
            )
              .sort((a, b) => {
                const result = a.id.localeCompare(b.id);
                return orderBy.direction === "asc" ? result : -result;
              })
              .slice(offset, offset + limit)
          : await orm.findMany("bundles", {
              select: selectedColumns,
              where: buildBundleWhere(where),
              orderBy: [[orderBy.field, orderBy.direction]],
              limit,
              offset,
            });

        return rows.map(mapBundleRecordToBundle);
      };

      if (!options.cursor?.after && !options.cursor?.before) {
        const data = await findBundles({
          where,
          orderBy,
          limit,
          offset,
        });

        return {
          data,
          pagination: {
            ...calculatePagination(total, { limit, offset }),
            ...(data.length > 0 && offset + data.length < total
              ? { nextCursor: data.at(-1)?.id }
              : {}),
            ...(data.length > 0 && offset > 0
              ? { previousCursor: data[0]?.id }
              : {}),
          },
        };
      }

      const {
        where: cursorWhere,
        orderBy: cursorOrderBy,
        reverseData,
      } = buildCursorPageWhere(where, options.cursor, orderBy);
      const cursorPage = await findBundles({
        where: cursorWhere,
        orderBy: cursorOrderBy,
        limit,
        offset: 0,
      });
      const data = reverseData ? cursorPage.slice().reverse() : cursorPage;

      if (data.length === 0) {
        const emptyStartIndex = options.cursor.after ? total : 0;
        return {
          data,
          pagination: {
            ...calculatePagination(total, {
              limit,
              offset: emptyStartIndex,
            }),
            ...(options.cursor.after
              ? { previousCursor: options.cursor.after }
              : {}),
            ...(options.cursor.before
              ? { nextCursor: options.cursor.before }
              : {}),
          },
        };
      }

      const startIndex = await orm.count("bundles", {
        where: buildBundleWhere(
          buildCountBeforeWhere(where, data[0]!.id, orderBy),
        ),
      });

      return {
        data,
        pagination: {
          ...calculatePagination(total, { limit, offset: startIndex }),
          ...(startIndex + data.length < total
            ? { nextCursor: data.at(-1)?.id }
            : {}),
          ...(startIndex > 0 ? { previousCursor: data[0]?.id } : {}),
        },
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
        metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
        manifest_storage_uri: getManifestStorageUri(bundle),
        manifest_file_hash: getManifestFileHash(bundle),
        asset_base_storage_uri: getAssetBaseStorageUri(bundle),
        patch_base_bundle_id: getPatchBaseBundleId(bundle),
        patch_base_file_hash: getPatchBaseFileHash(bundle),
        patch_file_hash: getPatchFileHash(bundle),
        patch_storage_uri: getPatchStorageUri(bundle),
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
        metadata: stripBundleArtifactMetadata(merged.metadata) ?? {},
        manifest_storage_uri: getManifestStorageUri(merged),
        manifest_file_hash: getManifestFileHash(merged),
        asset_base_storage_uri: getAssetBaseStorageUri(merged),
        patch_base_bundle_id: getPatchBaseBundleId(merged),
        patch_base_file_hash: getPatchBaseFileHash(merged),
        patch_file_hash: getPatchFileHash(merged),
        patch_storage_uri: getPatchStorageUri(merged),
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

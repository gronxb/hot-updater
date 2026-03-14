import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/plugin-core";
import type { InferFumaDB } from "fumadb";
import { fumadb } from "fumadb";
import type { FumaDBAdapter } from "fumadb/adapters";
import { calculatePagination } from "../calculatePagination";
import { v0_21_0 } from "../schema/v0_21_0";
import { v0_26_0 } from "../schema/v0_26_0";
import type { PaginationInfo } from "../types";
import type { DatabaseAPI } from "./types";

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 100);
}

function isDeviceEligibleForUpdate(
  userId: string,
  rolloutPercentage: number | null | undefined,
  targetDeviceIds: string[] | null | undefined,
): boolean {
  if (targetDeviceIds && targetDeviceIds.length > 0) {
    return targetDeviceIds.includes(userId);
  }

  if (
    rolloutPercentage === null ||
    rolloutPercentage === undefined ||
    rolloutPercentage >= 100
  ) {
    return true;
  }

  if (rolloutPercentage <= 0) {
    return false;
  }

  const userHash = hashUserId(userId);
  return userHash < rolloutPercentage;
}

const parseTargetDeviceIds = (value: unknown): string[] | null => {
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

const schemas = [v0_21_0, v0_26_0];

export const HotUpdaterDB = fumadb({
  namespace: "hot_updater",
  schemas,
});
export type HotUpdaterClient = InferFumaDB<typeof HotUpdaterDB>;

export type Migrator = ReturnType<HotUpdaterClient["createMigrator"]>;

export function createOrmDatabaseCore({
  database,
  resolveFileUrl,
}: {
  database: FumaDBAdapter;
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>;
}): {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
} {
  const client = HotUpdaterDB.client(database);

  const ensureORM = async () => {
    const lastSchemaVersion = schemas.at(-1)!.version as "0.26.0";

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

  const api: DatabaseAPI = {
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
          "rollout_percentage",
          "target_device_ids",
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
        rolloutPercentage: result.rollout_percentage ?? 100,
        targetDeviceIds: parseTargetDeviceIds(result.target_device_ids),
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
        rollout_percentage?: number | null;
        target_device_ids?: unknown | null;
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
        deviceId: string | undefined,
      ): boolean => {
        if (!deviceId) {
          return true;
        }

        return isDeviceEligibleForUpdate(
          deviceId,
          row.rollout_percentage ?? null,
          parseTargetDeviceIds(row.target_device_ids),
        );
      };

      const appVersionStrategy = async ({
        platform,
        appVersion,
        bundleId,
        minBundleId = NIL_UUID,
        channel = "production",
        deviceId,
      }: AppVersionGetBundlesArgs): Promise<UpdateInfo | null> => {
        const versionRows = await orm.findMany("bundles", {
          select: ["target_app_version"],
          where: (b) => b.and(b("platform", "=", platform)),
        });
        const allTargetVersions = Array.from(
          new Set(
            (versionRows ?? [])
              .map((r) => r.target_app_version)
              .filter((v): v is string => Boolean(v)),
          ),
        );
        const compatibleVersions = filterCompatibleAppVersions(
          allTargetVersions,
          appVersion,
        );

        const baseRows =
          compatibleVersions.length === 0
            ? []
            : await orm.findMany("bundles", {
                select: [
                  "id",
                  "should_force_update",
                  "message",
                  "storage_uri",
                  "file_hash",
                  "rollout_percentage",
                  "target_device_ids",
                  "channel",
                  "target_app_version",
                  "enabled",
                ],
                where: (b) =>
                  b.and(
                    b("enabled", "=", true),
                    b("platform", "=", platform),
                    b("id", ">=", minBundleId ?? NIL_UUID),
                    b("channel", "=", channel),
                    b.isNotNull("target_app_version"),
                  ),
              });

        const candidates = (baseRows ?? []).filter((r) =>
          r.target_app_version
            ? compatibleVersions.includes(r.target_app_version)
            : false,
        );

        const byIdDesc = (a: { id: string }, b: { id: string }) =>
          b.id.localeCompare(a.id);
        const sorted = (candidates ?? []).slice().sort(byIdDesc);

        const latestCandidate = sorted[0] ?? null;
        const currentBundle = sorted.find((b) => b.id === bundleId);
        const updateCandidate =
          sorted.find((b) => b.id.localeCompare(bundleId) > 0) ?? null;
        const rollbackCandidate =
          sorted.find((b) => b.id.localeCompare(bundleId) < 0) ?? null;

        if (bundleId === NIL_UUID) {
          if (latestCandidate && latestCandidate.id !== bundleId) {
            if (!isEligibleForUpdate(latestCandidate, deviceId)) {
              return null;
            }
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (currentBundle) {
          if (
            latestCandidate &&
            latestCandidate.id.localeCompare(currentBundle.id) > 0
          ) {
            if (!isEligibleForUpdate(latestCandidate, deviceId)) {
              return null;
            }
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (updateCandidate) {
          if (!isEligibleForUpdate(updateCandidate, deviceId)) {
            return null;
          }
          return toUpdateInfo(updateCandidate, "UPDATE");
        }
        if (rollbackCandidate) {
          return toUpdateInfo(rollbackCandidate, "ROLLBACK");
        }

        if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
          return null;
        }
        return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
      };

      const fingerprintStrategy = async ({
        platform,
        fingerprintHash,
        bundleId,
        minBundleId = NIL_UUID,
        channel = "production",
        deviceId,
      }: FingerprintGetBundlesArgs): Promise<UpdateInfo | null> => {
        const candidates = await orm.findMany("bundles", {
          select: [
            "id",
            "should_force_update",
            "message",
            "storage_uri",
            "file_hash",
            "rollout_percentage",
            "target_device_ids",
            "channel",
            "fingerprint_hash",
            "enabled",
          ],
          where: (b) =>
            b.and(
              b("enabled", "=", true),
              b("platform", "=", platform),
              b("id", ">=", minBundleId ?? NIL_UUID),
              b("channel", "=", channel),
              b("fingerprint_hash", "=", fingerprintHash),
            ),
        });

        const byIdDesc = (a: { id: string }, b: { id: string }) =>
          b.id.localeCompare(a.id);
        const sorted = (candidates ?? []).slice().sort(byIdDesc);

        const latestCandidate = sorted[0] ?? null;
        const currentBundle = sorted.find((b) => b.id === bundleId);
        const updateCandidate =
          sorted.find((b) => b.id.localeCompare(bundleId) > 0) ?? null;
        const rollbackCandidate =
          sorted.find((b) => b.id.localeCompare(bundleId) < 0) ?? null;

        if (bundleId === NIL_UUID) {
          if (latestCandidate && latestCandidate.id !== bundleId) {
            if (!isEligibleForUpdate(latestCandidate, deviceId)) {
              return null;
            }
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (currentBundle) {
          if (
            latestCandidate &&
            latestCandidate.id.localeCompare(currentBundle.id) > 0
          ) {
            if (!isEligibleForUpdate(latestCandidate, deviceId)) {
              return null;
            }
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (updateCandidate) {
          if (!isEligibleForUpdate(updateCandidate, deviceId)) {
            return null;
          }
          return toUpdateInfo(updateCandidate, "UPDATE");
        }
        if (rollbackCandidate) {
          return toUpdateInfo(rollbackCandidate, "ROLLBACK");
        }

        if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
          return null;
        }
        return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
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
    ): Promise<AppUpdateInfo | null> {
      const info = await this.getUpdateInfo(args);
      if (!info) return null;
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };
      const fileUrl = await resolveFileUrl(storageUri ?? null);
      return { ...rest, fileUrl };
    },

    async getChannels(): Promise<string[]> {
      const orm = await ensureORM();
      const rows = await orm.findMany("bundles", {
        select: ["channel"],
      });
      const set = new Set(rows?.map((r) => r.channel) ?? []);
      return Array.from(set);
    },

    async getBundles(options: {
      where?: { channel?: string; platform?: string };
      limit: number;
      offset: number;
    }): Promise<{ data: Bundle[]; pagination: PaginationInfo }> {
      const orm = await ensureORM();
      const { where, limit, offset } = options;

      const rows = await orm.findMany("bundles", {
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
          "rollout_percentage",
          "target_device_ids",
        ],
        where: (b) => {
          const conditions = [];
          if (where?.channel) {
            conditions.push(b("channel", "=", where.channel));
          }
          if (where?.platform) {
            conditions.push(b("platform", "=", where.platform));
          }
          return conditions.length > 0 ? b.and(...conditions) : true;
        },
      });

      const all: Bundle[] = rows
        .map(
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
            rolloutPercentage: r.rollout_percentage ?? 100,
            targetDeviceIds: parseTargetDeviceIds(r.target_device_ids),
          }),
        )
        .sort((a, b) => b.id.localeCompare(a.id));

      const total = all.length;
      const sliced = all.slice(offset, offset + limit);

      return {
        data: sliced,
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
        rollout_percentage: bundle.rolloutPercentage ?? 100,
        target_device_ids: bundle.targetDeviceIds ?? null,
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
        rollout_percentage: merged.rolloutPercentage ?? 100,
        target_device_ids: merged.targetDeviceIds ?? null,
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

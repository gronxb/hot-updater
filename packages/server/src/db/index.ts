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
import type { StoragePlugin } from "@hot-updater/plugin-core";
import { filterCompatibleAppVersions } from "@hot-updater/plugin-core";
import type { InferFumaDB } from "fumadb";
import { fumadb } from "fumadb";
import { calculatePagination } from "../calculatePagination";
import { createHandler } from "../handler";
import { v0_21_0 } from "../schema/v0_21_0";
import type { PaginationInfo } from "../types";

export const HotUpdaterDB = fumadb({
  namespace: "hot_updater",
  schemas: [v0_21_0],
});

export type HotUpdaterClient = InferFumaDB<typeof HotUpdaterDB>;

export type DatabaseAdapter = Parameters<typeof HotUpdaterDB.client>[0];

export interface DatabaseAPI {
  getBundleById(id: string): Promise<Bundle | null>;
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getAppUpdateInfo(args: GetBundlesArgs): Promise<AppUpdateInfo | null>;
  getChannels(): Promise<string[]>;
  getBundles(options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }): Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  insertBundle(bundle: Bundle): Promise<void>;
  updateBundleById(bundleId: string, newBundle: Partial<Bundle>): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
}

export type HotUpdaterAPI = DatabaseAPI & {
  handler: (request: Request) => Promise<Response>;

  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
};

export type Migrator = ReturnType<HotUpdaterClient["createMigrator"]>;

export type StoragePluginFactory = (args: { cwd: string }) => StoragePlugin;

export interface HotUpdaterOptions {
  database: DatabaseAdapter;
  storagePlugins?: (StoragePlugin | StoragePluginFactory)[];
  basePath?: string;
  cwd?: string;
}

export function createHotUpdater(options: HotUpdaterOptions): HotUpdaterAPI {
  const client = HotUpdaterDB.client(options.database);
  const cwd = options.cwd ?? process.cwd();

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (options?.storagePlugins ?? []).map((plugin) =>
    typeof plugin === "function" ? plugin({ cwd }) : plugin,
  );

  const resolveFileUrl = async (
    storageUri: string | null,
  ): Promise<string | null> => {
    if (!storageUri) {
      return null;
    }
    const url = new URL(storageUri);
    const protocol = url.protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return storageUri;
    }
    const plugin = storagePlugins.find((p) => p.supportedProtocol === protocol);

    if (!plugin) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }
    const { fileUrl } = await plugin.getDownloadUrl(storageUri);
    if (!fileUrl) {
      throw new Error("Storage plugin returned empty fileUrl");
    }
    return fileUrl;
  };

  const api = {
    async getBundleById(id: string): Promise<Bundle | null> {
      const version = await client.version();
      const orm = client.orm(version);
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
        ],
        where: (b) => b.and(b.isNotNull("id"), b("id", "=", id)),
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
      };
      return bundle;
    },
    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      const version = await client.version();
      const orm = client.orm(version);

      type UpdateSelectRow = {
        id: string;
        should_force_update: boolean;
        message: string | null;
        storage_uri: string | null;
        file_hash: string;
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

      const appVersionStrategy = async ({
        platform,
        appVersion,
        bundleId,
        minBundleId = NIL_UUID,
        channel = "production",
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
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (currentBundle) {
          if (
            latestCandidate &&
            latestCandidate.id.localeCompare(currentBundle.id) > 0
          ) {
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (updateCandidate) {
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
      }: FingerprintGetBundlesArgs): Promise<UpdateInfo | null> => {
        const candidates = await orm.findMany("bundles", {
          select: [
            "id",
            "should_force_update",
            "message",
            "storage_uri",
            "file_hash",
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
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (currentBundle) {
          if (
            latestCandidate &&
            latestCandidate.id.localeCompare(currentBundle.id) > 0
          ) {
            return toUpdateInfo(latestCandidate, "UPDATE");
          }
          return null;
        }

        if (updateCandidate) {
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
      const version = await client.version();
      const orm = client.orm(version);
      const rows = await orm.findMany("bundles", {
        select: ["channel"],
        where: (b) => b.isNotNull("channel"),
      });
      const set = new Set(rows?.map((r) => r.channel) ?? []);
      return Array.from(set);
    },

    async getBundles(options: {
      where?: { channel?: string; platform?: string };
      limit: number;
      offset: number;
    }): Promise<{ data: Bundle[]; pagination: PaginationInfo }> {
      const version = await client.version();
      const orm = client.orm(version);
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
        ],
        where: (b) =>
          b.and(
            b.isNotNull("id"),
            where?.channel
              ? b("channel", "=", where.channel)
              : b.isNotNull("id"),
            where?.platform
              ? b("platform", "=", where.platform)
              : b.isNotNull("id"),
          ),
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
      const version = await client.version();
      const orm = client.orm(version);
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
      const version = await client.version();
      const orm = client.orm(version);
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
      };
      const { id: id2, ...updateValues2 } = values;
      await orm.upsert("bundles", {
        where: (b) => b("id", "=", id2),
        create: values,
        update: updateValues2,
      });
    },

    async deleteBundleById(bundleId: string): Promise<void> {
      const version = await client.version();
      const orm = client.orm(version);
      await orm.deleteMany("bundles", { where: (b) => b("id", "=", bundleId) });
    },
  };

  return {
    ...api,
    handler: createHandler(
      api,
      options?.basePath ? { basePath: options.basePath } : {},
    ),

    // private method
    adapterName: client.adapter.name,
    createMigrator: () => client.createMigrator(),
    generateSchema: client.generateSchema,
  };
}

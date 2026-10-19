import {
  DatabaseConstraintError,
  isUUIDv7,
  type HotUpdaterCoreApi,
  type KeysetInput,
  type NativeBuildRegistration,
  type NativeBuildRow,
  type NativeBuildScope,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";

import type { CoreDatabase } from "./reads";
import { insertChannel, type CoreTransaction } from "./writes";

const ARTIFACT_KINDS = new Set(["apk", "aab", "ipa", "app"]);

const pick = (row: Readonly<Record<string, unknown>>): NativeBuildRow => ({
  id: row.id as string,
  scope_key: row.scope_key as string,
  platform: row.platform as NativeBuildRow["platform"],
  channel_id: row.channel_id as string,
  fingerprint_hash: (row.fingerprint_hash ?? null) as string | null,
  app_version: (row.app_version ?? null) as string | null,
  min_bundle_id: row.min_bundle_id as string,
  artifact_kind: row.artifact_kind as NativeBuildRow["artifact_kind"],
  artifact_storage_uri: row.artifact_storage_uri as string,
  byte_size: row.byte_size as number,
  git_commit_hash: (row.git_commit_hash ?? null) as string | null,
  created_at_ms: row.created_at_ms as number,
});

/**
 * A native build scope's key: the Release Catalog scope key of a
 * fingerprint, or of the app-version strategy followed by the exact app
 * version the build compiled in. One key serves both strategies, so one
 * index finds the newest build of either.
 */
export const nativeBuildScopeKey = (scope: NativeBuildScope): string => {
  const channelKey = encodeChannelKey(scope.channel);
  return scope.fingerprintHash !== null
    ? createReleaseCatalogScopeKey({
        channelKey,
        fingerprintHash: scope.fingerprintHash,
        platform: scope.platform,
        strategy: "FINGERPRINT",
      })
    : `${createReleaseCatalogScopeKey({
        channelKey,
        platform: scope.platform,
        strategy: "APP_VERSION",
      })}:${encodeURIComponent(scope.appVersion)}`;
};

/** Whether `bundleId` is a native build's built-in bundle: one unique read. */
export const isBuiltInBundle = async (
  db: Pick<CoreDatabase | CoreTransaction, "findOne">,
  bundleId: string,
): Promise<boolean> =>
  (await db.findOne("native_builds", { min_bundle_id: bundleId })) !== null;

const problemOf = ({
  id,
  minBundleId,
  platform,
  channel,
  fingerprintHash,
  appVersion,
  artifact,
}: NativeBuildRegistration): string | null => {
  if (!isUUIDv7(id)) return "id must be a UUIDv7";
  // A debug build's nil UUID is no UUIDv7: it has no built-in bundle.
  if (!isUUIDv7(minBundleId)) {
    return "minBundleId must be the UUIDv7 a release build compiles in";
  }
  if (platform !== "ios" && platform !== "android") {
    return "platform must be ios or android";
  }
  if (channel.trim().length === 0) return "channel is required";
  if ((fingerprintHash === null) === (appVersion === null)) {
    return "exactly one of fingerprintHash and appVersion is required";
  }
  if (!ARTIFACT_KINDS.has(artifact.kind)) {
    return "artifact.kind must be apk, aab, ipa, or app";
  }
  if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0) {
    return "artifact.byteSize must be a byte count";
  }
  return null;
};

/** The native build registry: core's `native_builds` and the built-in bundle rows. */
export const createNativeBuildApi = (
  db: CoreDatabase,
  { now = Date.now }: { readonly now?: () => number } = {},
): Pick<
  HotUpdaterCoreApi,
  "registerNativeBuild" | "findNativeBuild" | "listNativeBuilds"
> => ({
  async registerNativeBuild(registration) {
    const problem = problemOf(registration);
    if (problem !== null) {
      throw new TypeError(`Invalid native build: ${problem}.`);
    }
    const channel = (
      await insertChannel(db, {
        id: `channel:${encodeChannelKey(registration.channel)}`,
        name: registration.channel,
      })
    ).row;
    const { embeddedBundle } = registration;
    const row: NativeBuildRow = {
      id: registration.id,
      scope_key: nativeBuildScopeKey(registration),
      platform: registration.platform,
      channel_id: channel.id,
      fingerprint_hash: registration.fingerprintHash,
      app_version: registration.appVersion,
      min_bundle_id: registration.minBundleId,
      artifact_kind: registration.artifact.kind,
      artifact_storage_uri: registration.artifact.storageUri,
      byte_size: registration.artifact.byteSize,
      git_commit_hash: registration.gitCommitHash,
      created_at_ms: now(),
    };
    try {
      await db.transaction(async (tx) => {
        // The built-in bundle is no OTA bundle, so the bundle totals leave
        // it out: `deleteBundles` refuses it, so they never count it back.
        tx.create("bundles", {
          id: registration.minBundleId,
          platform: registration.platform,
          git_commit_hash: registration.gitCommitHash,
          metadata: embeddedBundle.metadata ?? {},
          manifest_storage_uri: embeddedBundle.manifestStorageUri,
          manifest_file_hash: embeddedBundle.manifestFileHash,
          asset_base_storage_uri: embeddedBundle.assetBaseStorageUri,
        });
        tx.create("native_builds", row);
      });
    } catch (error) {
      if (
        error instanceof DatabaseConstraintError &&
        (error.reason === "exists" || error.reason === "unique")
      ) {
        throw new DatabaseConstraintError(error.reason, "native_builds");
      }
      throw error;
    }
    return row;
  },

  async findNativeBuild(scope) {
    const { rows } = await db.findMany("native_builds", {
      index: "byScope",
      where: { scope_key: nativeBuildScopeKey(scope) },
      order: "desc",
      limit: 1,
    });
    return rows[0] === undefined ? null : pick(rows[0]);
  },

  async listNativeBuilds(input: KeysetInput) {
    const order = input.order ?? "asc";
    const page = await db.findMany("native_builds", {
      index: "all",
      where: {},
      order,
      limit: input.limit,
      ...(input.after === undefined
        ? {}
        : {
            range: order === "asc" ? { gt: input.after } : { lt: input.after },
          }),
    });
    return page.rows.map(pick);
  },
});

import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  NIL_UUID,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type AppUpdateAvailableInfo,
  type GetBundlesArgs,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
} from "@hot-updater/core";
import { getUpdateInfo as getLegacyUpdateInfo } from "@hot-updater/js";
import {
  canonicalizeAppVersion,
  createDatabaseClient,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  type CompiledReleaseCatalog,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";

import { resolveManifestArtifacts } from "./updateArtifacts";

type ResolveFileUrl = (storageUri: string | null) => Promise<string | null>;
type ReadStorageText = (storageUri: string) => Promise<string | null>;

export type ReleaseCatalogRequest =
  | {
      readonly strategy: "APP_VERSION";
      readonly authorityId: string;
      readonly platform: "ios" | "android";
      readonly channelKey: string;
      readonly appVersion: string;
    }
  | {
      readonly strategy: "FINGERPRINT";
      readonly authorityId: string;
      readonly platform: "ios" | "android";
      readonly channelKey: string;
      readonly fingerprintHash: string;
    };

const parseCompiledCatalog = (
  payload: string,
  strategy: ReleaseCatalogRequest["strategy"],
): CompiledReleaseCatalog => {
  const parsed: unknown = JSON.parse(payload);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "schemaVersion") !== RELEASE_CATALOG_SCHEMA_VERSION ||
    Reflect.get(parsed, "strategy") !== strategy ||
    Reflect.get(parsed, "fallbackPolicy") !== RELEASE_CATALOG_FALLBACK_POLICY ||
    !Array.isArray(Reflect.get(parsed, "releaseDescriptors"))
  ) {
    throw new Error("Stored Release catalog payload is invalid");
  }
  if (
    strategy === "APP_VERSION" &&
    !Array.isArray(Reflect.get(parsed, "segments"))
  ) {
    throw new Error("Stored app-version Release catalog is invalid");
  }
  if (
    strategy === "FINGERPRINT" &&
    !Array.isArray(Reflect.get(parsed, "releaseIndexes"))
  ) {
    throw new Error("Stored fingerprint Release catalog is invalid");
  }
  return parsed as CompiledReleaseCatalog;
};

export const createReleaseCatalogReader =
  (database: DatabasePlugin, authorityId: string) =>
  async (input: ReleaseCatalogRequest): Promise<ReleaseCatalog | null> => {
    if (input.authorityId !== authorityId) return null;
    const scopeKey =
      input.strategy === "APP_VERSION"
        ? createReleaseCatalogScopeKey({
            authorityId,
            channelKey: input.channelKey,
            platform: input.platform,
            strategy: "APP_VERSION",
          })
        : createReleaseCatalogScopeKey({
            authorityId,
            channelKey: input.channelKey,
            fingerprintHash: input.fingerprintHash,
            platform: input.platform,
            strategy: "FINGERPRINT",
          });
    const row = await database.models.releaseCatalogs.findByScopeKey(scopeKey);
    if (
      row === null ||
      row.authority_id !== authorityId ||
      row.platform !== input.platform ||
      row.strategy !== input.strategy ||
      row.channel_key !== input.channelKey ||
      row.scope_key !== scopeKey ||
      row.fingerprint_hash !==
        (input.strategy === "FINGERPRINT" ? input.fingerprintHash : null)
    ) {
      return null;
    }
    const compiled = parseCompiledCatalog(row.payload, input.strategy);
    const releases = projectCompiledCatalog(
      compiled,
      input.strategy === "APP_VERSION" ? input.appVersion : undefined,
    );
    const rollbackReleases = projectCompiledRollbackCatalog(
      compiled,
      input.strategy === "APP_VERSION" ? input.appVersion : undefined,
    );
    return {
      authorityId,
      catalogHash: row.catalog_hash,
      fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
      generation: row.generation,
      releases,
      rollbackReleases,
      schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
      scopeKey,
    };
  };

export const createArtifactResolver = (input: {
  readonly database: DatabasePlugin;
  readonly readStorageText?: ReadStorageText;
  readonly resolveFileUrl: ResolveFileUrl;
}) => {
  const databaseClient = createDatabaseClient(input.database);

  return async (
    targetBundleId: string,
    currentBundleId: string,
    policy?: Pick<
      ReleaseCatalogDescriptor,
      "message" | "rolloutCohortCount" | "shouldForceUpdate" | "targetCohorts"
    >,
  ): Promise<AppUpdateAvailableInfo | null> => {
    const [targetBundle, currentBundle] = await Promise.all([
      databaseClient.getBundleById(targetBundleId),
      currentBundleId === NIL_UUID
        ? null
        : databaseClient.getBundleById(currentBundleId),
    ]);
    if (targetBundle === null) return null;
    const base: AppUpdateAvailableInfo = {
      fileHash: targetBundle.fileHash,
      fileUrl: await input.resolveFileUrl(targetBundle.storageUri),
      id: targetBundle.id,
      message: policy?.message ?? null,
      shouldForceUpdate: policy?.shouldForceUpdate ?? false,
      status: "UPDATE",
      ...(policy === undefined
        ? {}
        : {
            rolloutCohortCount: policy.rolloutCohortCount,
            targetCohorts: [...policy.targetCohorts],
          }),
    };
    if (input.readStorageText === undefined) return base;
    const manifest = await resolveManifestArtifacts({
      currentBundle,
      readStorageText: input.readStorageText,
      resolveFileUrl: input.resolveFileUrl,
      targetBundle,
    });
    return manifest === null ? base : { ...base, ...manifest };
  };
};

export const createLegacyCatalogResolver =
  (input: {
    readonly authorityId: string;
    readonly getArtifact: ReturnType<typeof createArtifactResolver>;
    readonly getCatalog: ReturnType<typeof createReleaseCatalogReader>;
  }) =>
  async (args: GetBundlesArgs): Promise<AppUpdateAvailableInfo | null> => {
    const channel = args.channel ?? "production";
    const channelKey = encodeChannelKey(channel);
    const catalog =
      args._updateStrategy === "appVersion"
        ? await input.getCatalog({
            appVersion: canonicalizeAppVersion(args.appVersion) ?? "",
            authorityId: input.authorityId,
            channelKey,
            platform: args.platform,
            strategy: "APP_VERSION",
          })
        : await input.getCatalog({
            authorityId: input.authorityId,
            channelKey,
            fingerprintHash: args.fingerprintHash,
            platform: args.platform,
            strategy: "FINGERPRINT",
          });
    if (catalog === null) return null;
    const descriptorsByBundleId = new Map<string, ReleaseCatalogDescriptor>();
    for (const release of catalog.rollbackReleases ?? catalog.releases) {
      if (release.kind === "BUNDLE" && release.bundleId !== null) {
        // Catalog descriptors are newest-first. Legacy Bundle semantics cannot
        // represent multiple Releases for one artifact, so retain the newest
        // policy for the compatibility bridge.
        if (!descriptorsByBundleId.has(release.bundleId)) {
          descriptorsByBundleId.set(release.bundleId, release);
        }
      }
    }
    if (descriptorsByBundleId.size === 0) {
      const minBundleId = args.minBundleId ?? NIL_UUID;
      if (args.bundleId === NIL_UUID || args.bundleId <= minBundleId) {
        return null;
      }
      return {
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      };
    }
    const legacy = await getLegacyUpdateInfo(
      [...descriptorsByBundleId.values()].map((release) => ({
        channel,
        enabled: true,
        fileHash: "catalog-artifact",
        fingerprintHash:
          args._updateStrategy === "fingerprint" ? args.fingerprintHash : null,
        gitCommitHash: null,
        id: release.bundleId!,
        message: release.message,
        platform: args.platform,
        rolloutCohortCount: release.rolloutCohortCount,
        shouldForceUpdate: release.shouldForceUpdate,
        storageUri: `catalog://${release.bundleId}`,
        targetAppVersion: args._updateStrategy === "appVersion" ? "*" : null,
        targetCohorts: [...release.targetCohorts],
      })),
      { ...args, channel },
    );
    if (legacy === null) return null;
    if (legacy.id === NIL_UUID) {
      return {
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: legacy.message,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      };
    }
    const artifact = await input.getArtifact(legacy.id, args.bundleId);
    if (artifact === null) return null;
    return {
      ...artifact,
      message: legacy.message,
      shouldForceUpdate: legacy.shouldForceUpdate,
      status: legacy.status,
    };
  };

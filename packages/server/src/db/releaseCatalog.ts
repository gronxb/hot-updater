import {
  createReleaseCatalogScopeKey,
  isArtifactIntegrityToken,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
  NIL_UUID,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import {
  createDatabaseClient,
  MAX_BUNDLE_ARCHIVE_BYTES,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  rowToBundle,
  type CompiledReleaseCatalog,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";

import { resolveManifestArtifacts } from "./updateArtifacts";

type ResolveFileUrl = (storageUri: string | null) => Promise<string | null>;
type ReadStorageText = (storageUri: string) => Promise<string | null>;

const getUtf8ByteSize = (value: string) =>
  new TextEncoder().encode(value).byteLength;

export type ReleaseCatalogRequest =
  | {
      readonly strategy: "APP_VERSION";
      readonly platform: "ios" | "android";
      readonly channelKey: string;
      readonly appVersion: string;
    }
  | {
      readonly strategy: "FINGERPRINT";
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
  (database: DatabasePlugin) =>
  async (input: ReleaseCatalogRequest): Promise<ReleaseCatalog | null> => {
    const scopeKey =
      input.strategy === "APP_VERSION"
        ? createReleaseCatalogScopeKey({
            channelKey: input.channelKey,
            platform: input.platform,
            strategy: "APP_VERSION",
          })
        : createReleaseCatalogScopeKey({
            channelKey: input.channelKey,
            fingerprintHash: input.fingerprintHash,
            platform: input.platform,
            strategy: "FINGERPRINT",
          });
    const row = await database.models.releaseCatalogs.findByScopeKey(scopeKey);
    if (
      row === null ||
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
      catalogId: row.catalog_id,
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
  const getBundleForArtifact = async (bundleId: string) => {
    try {
      return await databaseClient.getBundleById(bundleId);
    } catch {
      const row = await input.database.models.bundles.findById(bundleId);
      return row ? rowToBundle(row) : null;
    }
  };

  return async (
    targetBundleId: string,
    currentBundleId: string,
  ): Promise<ArtifactInfo | null> => {
    const [targetBundle, currentBundle] = await Promise.all([
      getBundleForArtifact(targetBundleId),
      currentBundleId === NIL_UUID
        ? null
        : getBundleForArtifact(currentBundleId),
    ]);
    if (targetBundle === null) return null;
    const archiveMetadataValid =
      Number.isSafeInteger(targetBundle.archiveByteSize) &&
      targetBundle.archiveByteSize >= 0 &&
      targetBundle.archiveByteSize <= MAX_BUNDLE_ARCHIVE_BYTES;
    const archiveFileHash =
      archiveMetadataValid && isArtifactIntegrityToken(targetBundle.fileHash)
        ? targetBundle.fileHash
        : null;
    let archiveFileUrl: string | null = null;
    if (archiveFileHash !== null) {
      try {
        archiveFileUrl = await input.resolveFileUrl(targetBundle.storageUri);
      } catch {
        archiveFileUrl = null;
      }
    }
    const base: ArtifactInfo = {
      fileHash: archiveFileUrl === null ? null : archiveFileHash,
      fileUrl: archiveFileUrl,
    };
    if (input.readStorageText === undefined) {
      return archiveFileUrl === null ? null : base;
    }
    const manifest = await resolveManifestArtifacts({
      archiveUrlUsable: archiveFileUrl !== null,
      currentBundle,
      readStorageText: input.readStorageText,
      resolveFileUrl: input.resolveFileUrl,
      targetBundle,
    });
    if (manifest === null) return archiveFileUrl === null ? null : base;
    const artifact = { ...base, ...manifest };
    return getUtf8ByteSize(JSON.stringify(artifact)) <=
      MAX_UPDATE_ARTIFACT_RESPONSE_BYTES
      ? artifact
      : archiveFileUrl === null
        ? null
        : base;
  };
};

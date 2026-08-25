import {
  createReleaseCatalogScopeKey,
  NIL_UUID,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import {
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
  ): Promise<ArtifactInfo | null> => {
    const [targetBundle, currentBundle] = await Promise.all([
      databaseClient.getBundleById(targetBundleId),
      currentBundleId === NIL_UUID
        ? null
        : databaseClient.getBundleById(currentBundleId),
    ]);
    if (targetBundle === null) return null;
    const fileUrl = await input.resolveFileUrl(targetBundle.storageUri);
    const base: ArtifactInfo = {
      fileHash: targetBundle.fileHash,
      fileUrl,
    };
    if (input.readStorageText === undefined) return base;
    const manifest = await resolveManifestArtifacts({
      archiveUrlUsable: fileUrl !== null,
      currentBundle,
      readStorageText: input.readStorageText,
      resolveFileUrl: input.resolveFileUrl,
      targetBundle,
    });
    return manifest === null ? base : { ...base, ...manifest };
  };
};

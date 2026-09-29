import {
  createReleaseCatalogScopeKey,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type ReleaseCatalog,
} from "@hot-updater/core";
import {
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  type CompiledReleaseCatalog,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";

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

/** The scope key an update check reads. */
export const releaseCatalogScopeKeyOf = (
  input: ReleaseCatalogRequest,
): string =>
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

/** Projects a stored catalog row for one update check; null when the row is not this scope's. */
export const projectReleaseCatalogRow = (
  row: ReleaseCatalogRow | null,
  input: ReleaseCatalogRequest,
  scopeKey = releaseCatalogScopeKeyOf(input),
): ReleaseCatalog | null => {
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
  const appVersion =
    input.strategy === "APP_VERSION" ? input.appVersion : undefined;
  return {
    catalogId: row.catalog_id,
    catalogHash: row.catalog_hash,
    fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
    generation: row.generation,
    releases: projectCompiledCatalog(compiled, appVersion),
    rollbackReleases: projectCompiledRollbackCatalog(compiled, appVersion),
    schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
    scopeKey,
  };
};

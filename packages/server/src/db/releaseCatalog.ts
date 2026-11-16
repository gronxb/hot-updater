import {
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  type CompiledReleaseCatalog,
  type ReleaseCatalogRow,
  type ReleaseCatalogRequest,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type ReleaseCatalog,
} from "@hot-updater/protocol";

export type { ReleaseCatalogRequest };

/** A stored catalog payload, checked against its strategy's shape. */
export const parseCompiledCatalog = (
  payload: string,
  strategy: ReleaseCatalogRequest["strategy"],
): CompiledReleaseCatalog =>
  parseCompiledPayload(JSON.parse(payload), strategy);

/** A stored catalog payload already parsed from JSON, checked as `parseCompiledCatalog` checks it. */
export const parseCompiledPayload = (
  parsed: unknown,
  strategy: ReleaseCatalogRequest["strategy"],
): CompiledReleaseCatalog => {
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

/**
 * A stored catalog row with its payload parsed, which projects it for each
 * update check of its scope: the update-check memo keeps one per scope, so a
 * scope's app versions share one read and one parse of its row.
 */
export interface ParsedReleaseCatalogRow {
  readonly row: Omit<ReleaseCatalogRow, "payload">;
  readonly compiled: CompiledReleaseCatalog;
}

export const parseReleaseCatalogRow = ({
  payload,
  ...row
}: ReleaseCatalogRow): ParsedReleaseCatalogRow => ({
  row,
  compiled: parseCompiledCatalog(payload, row.strategy),
});

/**
 * The update check's answer from a stored row's identity and the two lists
 * for the device's version; null when the row is not this scope's.
 */
export const releaseCatalogAnswer = (
  row: Omit<ReleaseCatalogRow, "payload">,
  input: ReleaseCatalogRequest,
  scopeKey: string,
  lists: () => Pick<ReleaseCatalog, "releases" | "rollbackReleases">,
): ReleaseCatalog | null => {
  if (
    row.platform !== input.platform ||
    row.strategy !== input.strategy ||
    row.channel_key !== input.channelKey ||
    row.scope_key !== scopeKey ||
    row.fingerprint_hash !==
      (input.strategy === "FINGERPRINT" ? input.fingerprintHash : null)
  ) {
    return null;
  }
  const { releases, rollbackReleases } = lists();
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

/** Projects a parsed catalog row for one update check; null when the row is not this scope's. */
export const projectParsedReleaseCatalogRow = (
  parsed: ParsedReleaseCatalogRow | null,
  input: ReleaseCatalogRequest,
  scopeKey = releaseCatalogScopeKeyOf(input),
): ReleaseCatalog | null => {
  if (parsed === null) return null;
  const { row, compiled } = parsed;
  const appVersion =
    input.strategy === "APP_VERSION" ? input.appVersion : undefined;
  return releaseCatalogAnswer(row, input, scopeKey, () => ({
    releases: projectCompiledCatalog(compiled, appVersion),
    rollbackReleases: projectCompiledRollbackCatalog(compiled, appVersion),
  }));
};

/** Projects a stored catalog row for one update check; null when the row is not this scope's. */
export const projectReleaseCatalogRow = (
  row: ReleaseCatalogRow | null,
  input: ReleaseCatalogRequest,
  scopeKey = releaseCatalogScopeKeyOf(input),
): ReleaseCatalog | null =>
  projectParsedReleaseCatalogRow(
    row === null ? null : parseReleaseCatalogRow(row),
    input,
    scopeKey,
  );

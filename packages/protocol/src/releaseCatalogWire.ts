import {
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  MAX_TARGET_COHORTS_PER_RELEASE,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type ReleaseCatalog,
} from "./releaseCatalog";
import { parseReleaseCatalogScopeKey } from "./releaseCatalogScope";
import { NUMERIC_COHORT_SIZE } from "./rollout";
import { isUUIDv7 } from "./uuid";

/** The largest release catalog response body a client accepts, in UTF-8 bytes. */
export const MAX_RELEASE_CATALOG_WIRE_BYTES =
  MAX_COMPILED_CATALOG_BYTES * 2 + 4 * 1024;

/** The scope a client asked for: the catalog it accepts must be this scope's. */
export type ExpectedReleaseCatalogScope = {
  readonly channelKey: string;
  readonly platform: "ios" | "android";
} & (
  | {
      readonly strategy: "APP_VERSION";
      readonly fingerprintHash?: never;
    }
  | {
      readonly strategy: "FINGERPRINT";
      readonly fingerprintHash: string;
    }
);

/** The length of `value` in UTF-8 bytes, without an encoder the device may lack. */
export const getUtf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isValidReleaseDescriptor = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;

  return (
    isUUIDv7(descriptor.releaseId) &&
    descriptor.kind === "BUNDLE" &&
    typeof descriptor.bundleId === "string" &&
    Number.isSafeInteger(descriptor.rolloutCohortCount) &&
    (descriptor.rolloutCohortCount as number) >= 0 &&
    (descriptor.rolloutCohortCount as number) <= NUMERIC_COHORT_SIZE &&
    isStringArray(descriptor.targetCohorts) &&
    descriptor.targetCohorts.length <= MAX_TARGET_COHORTS_PER_RELEASE &&
    typeof descriptor.shouldForceUpdate === "boolean" &&
    (descriptor.message === null || typeof descriptor.message === "string")
  );
};

/** Whether the catalog is the expected scope's. */
export const hasExpectedReleaseCatalogScope = (
  catalog: Pick<ReleaseCatalog, "scopeKey">,
  expected: ExpectedReleaseCatalogScope,
): boolean => {
  try {
    const parsed = parseReleaseCatalogScopeKey(catalog.scopeKey);
    return (
      parsed.channelKey === expected.channelKey &&
      parsed.platform === expected.platform &&
      parsed.strategy === expected.strategy &&
      (parsed.strategy === "APP_VERSION" ||
        (expected.strategy === "FINGERPRINT" &&
          parsed.fingerprintHash === expected.fingerprintHash))
    );
  } catch {
    return false;
  }
};

/**
 * Parses a release catalog response body as a client accepts it: within the
 * wire limit, in the schema's shape, for the expected scope, and within the
 * cohort limits. Any other body is null. The device's update client and
 * doctor's server checks both run this, so they accept the same catalogs.
 */
export const parseReleaseCatalog = (
  body: string,
  expectedScope: ExpectedReleaseCatalogScope,
): ReleaseCatalog | null => {
  if (getUtf8ByteLength(body) > MAX_RELEASE_CATALOG_WIRE_BYTES) return null;

  try {
    const catalog = JSON.parse(body) as Partial<ReleaseCatalog>;
    if (
      catalog.schemaVersion !== RELEASE_CATALOG_SCHEMA_VERSION ||
      typeof catalog.catalogId !== "string" ||
      catalog.catalogId.length === 0 ||
      typeof catalog.scopeKey !== "string" ||
      !Number.isSafeInteger(catalog.generation) ||
      (catalog.generation ?? 0) < 1 ||
      typeof catalog.catalogHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(catalog.catalogHash) ||
      catalog.fallbackPolicy !== RELEASE_CATALOG_FALLBACK_POLICY ||
      !Array.isArray(catalog.releases) ||
      !catalog.releases.every(isValidReleaseDescriptor) ||
      !Array.isArray(catalog.rollbackReleases) ||
      !catalog.rollbackReleases.every(isValidReleaseDescriptor)
    ) {
      return null;
    }
    if (
      !hasExpectedReleaseCatalogScope(catalog as ReleaseCatalog, expectedScope)
    ) {
      return null;
    }
    const distinctTargetCohorts = new Set(
      [...catalog.releases, ...catalog.rollbackReleases].flatMap(
        (release) => release.targetCohorts,
      ),
    );
    if (distinctTargetCohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) {
      return null;
    }
    return catalog as ReleaseCatalog;
  } catch {
    return null;
  }
};

import {
  MAX_TARGET_COHORTS_PER_RELEASE,
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  NUMERIC_COHORT_SIZE,
  type ReleaseCatalog,
} from "@hot-updater/core";

const CACHE_FORMAT_VERSION = "1";
const MAX_ETAG_BYTES = 1024;
export const MAX_RELEASE_CATALOG_WIRE_BYTES =
  MAX_COMPILED_CATALOG_BYTES + 4 * 1024;
export const MAX_RELEASE_CATALOG_CACHE_ENTRY_BYTES =
  MAX_RELEASE_CATALOG_WIRE_BYTES + MAX_ETAG_BYTES + 3;

const readNativeReleaseCatalogCache = async (partition: string) =>
  (await import("./catalogCacheNative")).readNativeReleaseCatalogCache(
    partition,
  );

const writeNativeReleaseCatalogCache = async (
  partition: string,
  payload: string,
) =>
  (await import("./catalogCacheNative")).writeNativeReleaseCatalogCache(
    partition,
    payload,
  );

const removeNativeReleaseCatalogCache = async (partition: string) =>
  (await import("./catalogCacheNative")).removeNativeReleaseCatalogCache(
    partition,
  );

type CachedCatalog = {
  readonly catalog: ReleaseCatalog;
  readonly etag: string;
};

let lastParsedCache:
  | (CachedCatalog & {
      readonly authorityId: string;
      readonly serialized: string;
      readonly scopeKey: string;
    })
  | null = null;

type FetchReleaseCatalogInput = {
  readonly authorityId: string;
  readonly baseURL: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly scopeKey: string;
  readonly url: string;
};

const getUtf8ByteLength = (value: string): number => {
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
    typeof descriptor.releaseId === "string" &&
    (descriptor.kind === "BUNDLE" || descriptor.kind === "EMBEDDED") &&
    ((descriptor.kind === "BUNDLE" &&
      typeof descriptor.bundleId === "string") ||
      (descriptor.kind === "EMBEDDED" && descriptor.bundleId === null)) &&
    Number.isSafeInteger(descriptor.rolloutCohortCount) &&
    (descriptor.rolloutCohortCount as number) >= 0 &&
    (descriptor.rolloutCohortCount as number) <= NUMERIC_COHORT_SIZE &&
    isStringArray(descriptor.targetCohorts) &&
    descriptor.targetCohorts.length <= MAX_TARGET_COHORTS_PER_RELEASE &&
    typeof descriptor.shouldForceUpdate === "boolean" &&
    (descriptor.message === null || typeof descriptor.message === "string")
  );
};

const parseValidatedCatalog = (
  value: string,
  authorityId: string,
  scopeKey: string,
): ReleaseCatalog | null => {
  if (getUtf8ByteLength(value) > MAX_RELEASE_CATALOG_WIRE_BYTES) return null;

  try {
    const catalog = JSON.parse(value) as Partial<ReleaseCatalog>;
    if (
      catalog.schemaVersion !== 1 ||
      catalog.authorityId !== authorityId ||
      catalog.scopeKey !== scopeKey ||
      !Number.isSafeInteger(catalog.generation) ||
      (catalog.generation ?? 0) < 1 ||
      typeof catalog.catalogHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(catalog.catalogHash) ||
      catalog.fallbackPolicy !== "BUILTIN_IF_ACTIVE_INELIGIBLE" ||
      !Array.isArray(catalog.releases) ||
      !catalog.releases.every(isValidReleaseDescriptor)
    ) {
      return null;
    }
    const distinctTargetCohorts = new Set(
      catalog.releases.flatMap((release) => release.targetCohorts),
    );
    if (distinctTargetCohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) {
      return null;
    }
    return catalog as ReleaseCatalog;
  } catch {
    return null;
  }
};

const isValidETag = (value: string | null): value is string =>
  value !== null &&
  value.length > 0 &&
  !value.includes("\r") &&
  !value.includes("\n") &&
  getUtf8ByteLength(value) <= MAX_ETAG_BYTES;

const serializeCache = (etag: string, body: string): string =>
  `${CACHE_FORMAT_VERSION}\n${etag}\n${body}`;

const parseCache = (
  value: string,
  authorityId: string,
  scopeKey: string,
): CachedCatalog | null => {
  if (
    lastParsedCache !== null &&
    lastParsedCache.serialized === value &&
    lastParsedCache.authorityId === authorityId &&
    lastParsedCache.scopeKey === scopeKey
  ) {
    return lastParsedCache;
  }
  const versionEnd = value.indexOf("\n");
  const etagEnd = value.indexOf("\n", versionEnd + 1);
  if (
    versionEnd === -1 ||
    etagEnd === -1 ||
    value.slice(0, versionEnd) !== CACHE_FORMAT_VERSION
  ) {
    return null;
  }

  const etag = value.slice(versionEnd + 1, etagEnd);
  const body = value.slice(etagEnd + 1);
  if (!isValidETag(etag)) return null;
  const catalog = parseValidatedCatalog(body, authorityId, scopeKey);
  if (catalog === null) return null;
  const parsed = { authorityId, catalog, etag, scopeKey, serialized: value };
  lastParsedCache = parsed;
  return parsed;
};

const normalizedHeaders = (
  requestHeaders: Record<string, string> | undefined,
): readonly (readonly [string, string])[] => {
  const headers = new Headers(requestHeaders);
  return [...headers.entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([firstName], [secondName]) => firstName.localeCompare(secondName));
};

export const createReleaseCatalogCachePartition = (
  input: Pick<
    FetchReleaseCatalogInput,
    "authorityId" | "baseURL" | "requestHeaders" | "scopeKey" | "url"
  >,
): string =>
  JSON.stringify({
    authorityId: input.authorityId,
    baseURL: input.baseURL,
    headers: normalizedHeaders(input.requestHeaders),
    scopeKey: input.scopeKey,
    url: input.url,
    version: 1,
  });

const fetchCatalogResponse = async (
  input: FetchReleaseCatalogInput,
  etag?: string,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    input.requestTimeout ?? 5000,
  );

  try {
    const headers = new Headers(input.requestHeaders);
    headers.set("Accept", "application/json");
    if (etag === undefined) {
      headers.delete("If-None-Match");
    } else {
      headers.set("If-None-Match", etag);
    }
    return await fetch(input.url, {
      headers,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const readValidatedCache = async (
  partition: string,
  authorityId: string,
  scopeKey: string,
): Promise<CachedCatalog | null> => {
  const value = await readNativeReleaseCatalogCache(partition);
  if (value === null) return null;

  const cached = parseCache(value, authorityId, scopeKey);
  if (cached === null) {
    await removeNativeReleaseCatalogCache(partition);
  }
  return cached;
};

const consumeSuccessfulResponse = async (
  response: Response,
  input: FetchReleaseCatalogInput,
  partition: string,
): Promise<ReleaseCatalog> => {
  if (response.status !== 200) {
    throw new Error(response.statusText);
  }

  const body = await response.text();
  const catalog = parseValidatedCatalog(
    body,
    input.authorityId,
    input.scopeKey,
  );
  if (catalog === null) {
    await removeNativeReleaseCatalogCache(partition);
    throw new Error("Received an invalid Release catalog");
  }

  const etag = response.headers.get("etag");
  if (isValidETag(etag)) {
    const serialized = serializeCache(etag, body);
    if (getUtf8ByteLength(serialized) > MAX_RELEASE_CATALOG_CACHE_ENTRY_BYTES) {
      await removeNativeReleaseCatalogCache(partition);
      return catalog;
    }
    if (await writeNativeReleaseCatalogCache(partition, serialized)) {
      lastParsedCache = {
        authorityId: input.authorityId,
        catalog,
        etag,
        scopeKey: input.scopeKey,
        serialized,
      };
    }
  } else {
    await removeNativeReleaseCatalogCache(partition);
  }
  return catalog;
};

export const fetchReleaseCatalogWithCache = async (
  input: FetchReleaseCatalogInput,
): Promise<ReleaseCatalog> => {
  const partition = createReleaseCatalogCachePartition(input);
  const cached = await readValidatedCache(
    partition,
    input.authorityId,
    input.scopeKey,
  );
  const response = await fetchCatalogResponse(input, cached?.etag);

  if (response.status === 304) {
    if (cached !== null) return cached.catalog;

    const repairResponse = await fetchCatalogResponse(input);
    return consumeSuccessfulResponse(repairResponse, input, partition);
  }

  return consumeSuccessfulResponse(response, input, partition);
};

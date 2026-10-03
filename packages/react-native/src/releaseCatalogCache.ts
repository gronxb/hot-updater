import {
  type ExpectedReleaseCatalogScope,
  getUtf8ByteLength,
  MAX_RELEASE_CATALOG_WIRE_BYTES,
  parseReleaseCatalog,
  type ReleaseCatalog,
} from "@hot-updater/protocol";

import { fetchUpdateResponse, type UpdateRequest } from "./fetchUpdateResponse";
import { InvalidUpdateResponseError, UpdateHttpError } from "./updateError";

const CACHE_FORMAT_VERSION = "1";
const MAX_ETAG_BYTES = 1024;
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
      readonly partition: string;
      readonly serialized: string;
    })
  | null = null;

type FetchReleaseCatalogInput = {
  readonly baseURL: string;
  readonly expectedScope: ExpectedReleaseCatalogScope;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly url: string;
  readonly onResponse?: UpdateRequest["onResponse"];
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
  expectedScope: ExpectedReleaseCatalogScope,
  partition: string,
): CachedCatalog | null => {
  if (
    lastParsedCache !== null &&
    lastParsedCache.serialized === value &&
    lastParsedCache.partition === partition
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
  const catalog = parseReleaseCatalog(body, expectedScope);
  if (catalog === null) return null;
  const parsed = { catalog, etag, partition, serialized: value };
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
  input: Pick<FetchReleaseCatalogInput, "baseURL" | "requestHeaders" | "url">,
): string =>
  JSON.stringify({
    baseURL: input.baseURL,
    headers: normalizedHeaders(input.requestHeaders),
    url: input.url,
    version: 2,
  });

const isEmptyCatalogResponse = (response: Response) =>
  response.status === 404 &&
  response.headers.get("x-hot-updater-catalog")?.trim().toLowerCase() ===
    "none";

const fetchCatalogResponse = (
  input: FetchReleaseCatalogInput,
  etag?: string,
) => {
  const headers = new Headers(input.requestHeaders);
  headers.set("Accept", "application/json");
  if (etag === undefined) headers.delete("If-None-Match");
  else headers.set("If-None-Match", etag);
  return fetchUpdateResponse({
    ...input,
    resource: "catalog",
    requestHeaders: Object.fromEntries(headers.entries()),
  });
};

const readValidatedCache = async (
  partition: string,
  expectedScope: ExpectedReleaseCatalogScope,
): Promise<CachedCatalog | null> => {
  const value = await readNativeReleaseCatalogCache(partition);
  if (value === null) return null;

  const cached = parseCache(value, expectedScope, partition);
  if (cached === null) {
    await removeNativeReleaseCatalogCache(partition);
  }
  return cached;
};

const consumeSuccessfulResponse = async (
  { response, body }: Awaited<ReturnType<typeof fetchCatalogResponse>>,
  input: FetchReleaseCatalogInput,
  partition: string,
): Promise<ReleaseCatalog | null> => {
  // The server marks the 404 of a scope that has no catalog yet: no update,
  // not a failure. Any other 404 is a wrong baseURL or route.
  if (isEmptyCatalogResponse(response)) {
    return null;
  }
  if (response.status !== 200) {
    throw new UpdateHttpError(response.status, response.statusText);
  }

  const catalog = parseReleaseCatalog(body!, input.expectedScope);
  if (catalog === null) {
    await removeNativeReleaseCatalogCache(partition);
    throw new InvalidUpdateResponseError("Received an invalid Release catalog");
  }

  const etag = response.headers.get("etag");
  if (isValidETag(etag)) {
    const serialized = serializeCache(etag, body!);
    if (getUtf8ByteLength(serialized) > MAX_RELEASE_CATALOG_CACHE_ENTRY_BYTES) {
      await removeNativeReleaseCatalogCache(partition);
      return catalog;
    }
    if (await writeNativeReleaseCatalogCache(partition, serialized)) {
      lastParsedCache = {
        catalog,
        etag,
        partition,
        serialized,
      };
    }
  } else {
    await removeNativeReleaseCatalogCache(partition);
  }
  return catalog;
};

/**
 * Fetches a scope's catalog, or null when the server answers that the scope
 * has none (a 404 with `x-hot-updater-catalog: none`).
 */
export const fetchReleaseCatalogWithCache = async (
  input: FetchReleaseCatalogInput,
): Promise<ReleaseCatalog | null> => {
  const partition = createReleaseCatalogCachePartition(input);
  const cached = await readValidatedCache(partition, input.expectedScope);
  const response = await fetchCatalogResponse(input, cached?.etag);

  if (response.response.status === 304) {
    if (cached !== null) return cached.catalog;

    const repairResponse = await fetchCatalogResponse(input);
    return consumeSuccessfulResponse(repairResponse, input, partition);
  }

  return consumeSuccessfulResponse(response, input, partition);
};

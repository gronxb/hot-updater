import {
  StoragePluginError,
  type StorageObjectMetadata,
} from "@hot-updater/plugin-core/storage";

import {
  decodeStandaloneStorageHeader,
  encodeStandaloneStorageHeader,
  STANDALONE_STORAGE_V2,
} from "./standaloneStorageContract";

export const standaloneStorageErrorStatus = (
  error: StoragePluginError,
): number => {
  switch (error.code) {
    case "invalid-input":
    case "invalid-uri":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "rate-limited":
      return 429;
    case "aborted":
      return 499;
    case "timeout":
      return 504;
    case "integrity":
      return 422;
    case "unsupported":
      return 501;
    case "provider":
      return 502;
  }
};

export const requireStandaloneStorageHeader = (
  request: Request,
  name: string,
): string => {
  const value = decodeStandaloneStorageHeader(request.headers, name);
  if (value !== undefined && value !== "") return value;
  throw new StoragePluginError(
    "invalid-input",
    "Standalone storage request is invalid.",
  );
};

export const parseStandaloneIntegerHeader = (
  request: Request,
  name: string,
): number | undefined => {
  const value = request.headers.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (/^(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(parsed)) {
    return parsed;
  }
  throw new StoragePluginError(
    "invalid-input",
    "Standalone storage request is invalid.",
  );
};

export const parseStandaloneMetadata = (
  request: Request,
): Readonly<Record<string, string>> => {
  const encoded = requireStandaloneStorageHeader(
    request,
    STANDALONE_STORAGE_V2.headers.metadata,
  );
  try {
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === "string")
    ) {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, String(item)]),
        ),
      );
    }
    throw new StoragePluginError(
      "invalid-input",
      "Standalone storage request is invalid.",
    );
  } catch (error) {
    if (error instanceof StoragePluginError) throw error;
    if (error instanceof SyntaxError) {
      throw new StoragePluginError(
        "invalid-input",
        "Standalone storage request is invalid.",
      );
    }
    throw error;
  }
};

export const parseStandaloneRange = (
  request: Request,
): Readonly<{ start: number; end?: number }> | undefined => {
  const value = request.headers.get("range");
  if (value === null) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value);
  const start = match === null ? Number.NaN : Number(match[1]);
  const end = match === null || match[2] === "" ? undefined : Number(match[2]);
  if (
    match === null ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    throw new StoragePluginError(
      "invalid-input",
      "Standalone storage range is invalid.",
    );
  }
  return Object.freeze({
    start,
    ...(end === undefined ? {} : { end }),
  });
};

export const standaloneStorageMetadataHeaders = (
  metadata: StorageObjectMetadata,
  storageUri: string,
): Headers => {
  const headers = new Headers({
    [STANDALONE_STORAGE_V2.headers.contentLength]: String(
      metadata.contentLength,
    ),
    [STANDALONE_STORAGE_V2.headers.metadata]: encodeStandaloneStorageHeader(
      JSON.stringify(metadata.custom ?? {}),
    ),
    [STANDALONE_STORAGE_V2.headers.storageUri]:
      encodeStandaloneStorageHeader(storageUri),
  });
  if (metadata.contentType !== undefined) {
    headers.set("content-type", metadata.contentType);
  }
  if (metadata.etag !== undefined) headers.set("etag", metadata.etag);
  if (metadata.lastModified !== undefined) {
    headers.set("last-modified", metadata.lastModified);
  }
  return headers;
};

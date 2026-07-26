import {
  StoragePluginError,
  type StorageObjectMetadata,
} from "@hot-updater/plugin-core/storage";

import {
  assertActive,
  encodePath,
  requireSuccess,
  type SupabaseStorageClient,
} from "./transport";

type InfoResponse = Readonly<{
  content_type?: unknown;
  etag?: unknown;
  last_modified?: unknown;
  metadata?: unknown;
  size?: unknown;
  updated_at?: unknown;
}>;

export const parseStorageUri = (
  storageUri: string,
  client: SupabaseStorageClient,
): string => {
  const url = new URL(storageUri);
  if (url.host !== client.config.bucketName) {
    throw new StoragePluginError(
      "invalid-uri",
      "Supabase storage URI bucket does not match the configured bucket.",
    );
  }
  const key = url.pathname
    .replace(/^\/+/u, "")
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  if (key.length === 0) {
    throw new StoragePluginError(
      "invalid-uri",
      "Supabase storage URI key is empty.",
    );
  }
  return key;
};

export const createStorageUri = (
  client: SupabaseStorageClient,
  key: string,
): string => `supabase-storage://${client.config.bucketName}/${key}`;

const parseCustomMetadata = (
  value: unknown,
): Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.freeze(Object.fromEntries(entries));
};

export const readObjectInfo = async (
  client: SupabaseStorageClient,
  key: string,
  signal?: AbortSignal,
): Promise<StorageObjectMetadata | undefined> => {
  await assertActive(signal);
  const response = await client.request(
    `object/info/${encodePath(client.config.bucketName)}/${encodePath(key)}`,
    { method: "GET", signal },
  );
  if (response.status === 404) {
    return undefined;
  }
  await requireSuccess(response);
  const info: unknown = await response.json().catch(() => undefined);
  if (
    typeof info !== "object" ||
    info === null ||
    !("size" in info) ||
    typeof info.size !== "number" ||
    !Number.isSafeInteger(info.size) ||
    info.size < 0
  ) {
    throw new StoragePluginError(
      "provider",
      "Supabase Storage returned invalid object info.",
    );
  }
  const typed: InfoResponse = info;
  const lastModified =
    typeof typed.last_modified === "string"
      ? typed.last_modified
      : typeof typed.updated_at === "string"
        ? typed.updated_at
        : undefined;
  return {
    contentLength: info.size,
    ...(typeof typed.content_type === "string"
      ? { contentType: typed.content_type }
      : {}),
    ...(typeof typed.etag === "string" ? { etag: typed.etag } : {}),
    ...(lastModified === undefined ? {} : { lastModified }),
    custom: parseCustomMetadata(typed.metadata),
  };
};

export const readSignedUrl = async (
  response: Response,
  client: SupabaseStorageClient,
): Promise<string> => {
  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value !== "object" || value === null) {
    throw new StoragePluginError(
      "provider",
      "Supabase Storage returned an invalid signed URL.",
    );
  }
  const signedUrl =
    "signedURL" in value && typeof value.signedURL === "string"
      ? value.signedURL
      : "signedUrl" in value && typeof value.signedUrl === "string"
        ? value.signedUrl
        : undefined;
  if (
    signedUrl === undefined ||
    !URL.canParse(signedUrl, client.config.baseUrl)
  ) {
    throw new StoragePluginError(
      "provider",
      "Supabase Storage returned an invalid signed URL.",
    );
  }
  return new URL(signedUrl, client.config.baseUrl).href;
};

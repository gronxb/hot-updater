import {
  ConfigReferenceError,
  isConfigReference,
  resolveConfigReference,
  type ConfigReference,
} from "@hot-updater/core/config";
import {
  StoragePluginError,
  type StorageObjectMetadata,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";

export type StringConfigValue = string | ConfigReference<"env" | "secret">;

export const resolveStringConfig = (
  value: StringConfigValue,
  context: StorageOperationContext,
): string => {
  try {
    const resolved = resolveConfigReference(value, context);
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new StoragePluginError(
        "invalid-input",
        "Cloudflare R2 storage configuration is invalid.",
      );
    }
    return resolved;
  } catch (error) {
    if (
      error instanceof ConfigReferenceError ||
      error instanceof StoragePluginError
    ) {
      throw new StoragePluginError(
        "invalid-input",
        "Cloudflare R2 storage configuration could not be resolved.",
        { cause: error },
      );
    }
    throw error;
  }
};

export const hasConfigReference = (value: unknown): boolean => {
  if (isConfigReference(value)) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).some(hasConfigReference);
};

export const createObjectKey = (basePath: string | undefined, key: string) => {
  const normalized = [basePath, key]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map((part) => part.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, ""))
    .filter(Boolean)
    .join("/");
  if (normalized.length === 0) {
    throw new StoragePluginError(
      "invalid-input",
      "Cloudflare R2 object key must be non-empty.",
    );
  }
  return normalized;
};

export const parseR2Uri = (storageUri: string, bucketName: string): string => {
  const url = new URL(storageUri);
  if (url.hostname !== bucketName) {
    throw new StoragePluginError(
      "invalid-uri",
      "Cloudflare R2 storage URI bucket does not match the configured bucket.",
    );
  }
  const key = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
  if (key.length === 0) {
    throw new StoragePluginError(
      "invalid-uri",
      "Cloudflare R2 storage URI object key must be non-empty.",
    );
  }
  return key;
};

export const createR2Uri = (bucketName: string, key: string): string =>
  `r2://${bucketName}/${key.split("/").map(encodeURIComponent).join("/")}`;

type R2MetadataSource = Readonly<{
  size: number;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: Readonly<{ contentType?: string }>;
  customMetadata?: Readonly<Record<string, string>>;
}>;

export const createObjectMetadata = (
  object: R2MetadataSource,
): StorageObjectMetadata => ({
  contentLength: object.size,
  ...(object.httpMetadata?.contentType === undefined
    ? {}
    : { contentType: object.httpMetadata.contentType }),
  ...(object.etag === undefined ? {} : { etag: object.etag }),
  ...(object.uploaded === undefined
    ? {}
    : { lastModified: object.uploaded.toISOString() }),
  ...(object.customMetadata === undefined
    ? {}
    : { custom: object.customMetadata }),
});

export const throwIfAborted = async (
  signal: AbortSignal | undefined,
  body?: ReadableStream<Uint8Array>,
): Promise<void> => {
  if (signal?.aborted !== true) {
    return;
  }
  await body?.cancel().then(undefined, () => undefined);
  throw new StoragePluginError("aborted", "Storage operation was aborted.");
};

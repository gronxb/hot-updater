import {
  ConfigReferenceError,
  isConfigReference,
  resolveConfigReference,
  type ConfigReference,
} from "@hot-updater/core/config";
import { signToken } from "@hot-updater/js";
import {
  createStoragePlugin,
  StoragePluginError,
  type StorageOperationContext,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import {
  createObjectKey,
  createObjectMetadata,
  createR2Uri,
  parseR2Uri,
  resolveStringConfig,
  type StringConfigValue,
  throwIfAborted,
} from "./shared";

export type R2WorkerStorageConfig = Readonly<{
  bucket: R2Bucket | ConfigReference<"binding">;
  bucketName: StringConfigValue;
  basePath?: string;
  publicBaseUrl?: StringConfigValue;
  jwtSecret?: StringConfigValue;
}>;

const configurationError = (cause?: unknown): StoragePluginError =>
  new StoragePluginError(
    "invalid-input",
    "Cloudflare R2 Worker storage configuration could not be resolved.",
    cause === undefined ? undefined : { cause },
  );

const isR2Bucket = (value: unknown): value is R2Bucket =>
  typeof value === "object" &&
  value !== null &&
  "put" in value &&
  typeof value.put === "function" &&
  "head" in value &&
  typeof value.head === "function" &&
  "get" in value &&
  typeof value.get === "function" &&
  "delete" in value &&
  typeof value.delete === "function";

const resolveBucket = (
  value: R2WorkerStorageConfig["bucket"],
  context: StorageOperationContext,
): R2Bucket => {
  if (context.target !== "worker") {
    throw new StoragePluginError(
      "invalid-input",
      'Cloudflare R2 Worker storage requires context.target "worker".',
    );
  }
  try {
    const resolved = isConfigReference(value)
      ? resolveConfigReference(value, context)
      : value;
    if (!isR2Bucket(resolved)) {
      throw configurationError();
    }
    return resolved;
  } catch (error) {
    if (
      error instanceof ConfigReferenceError ||
      error instanceof StoragePluginError
    ) {
      throw configurationError(error);
    }
    throw error;
  }
};

const createDownloadUrl = async (
  config: R2WorkerStorageConfig,
  storageUri: string,
  context: StorageOperationContext,
): Promise<string> => {
  const publicBaseUrl = config.publicBaseUrl;
  if (publicBaseUrl === undefined) {
    throw new StoragePluginError(
      "provider",
      "Cloudflare R2 public download URL is unavailable.",
    );
  }
  const url = new URL(resolveStringConfig(publicBaseUrl, context));
  const storageUrl = new URL(storageUri);
  url.pathname = `${storageUrl.hostname}${storageUrl.pathname}`;
  url.search = "";
  if (config.jwtSecret !== undefined) {
    const token = await signToken(
      `${storageUrl.hostname}${storageUrl.pathname}`,
      resolveStringConfig(config.jwtSecret, context),
    );
    url.searchParams.set("token", token);
  }
  return url.toString();
};

const createImplementation = (
  config: R2WorkerStorageConfig,
): StoragePluginImplementation => ({
  async put(input) {
    const body = input.body instanceof Uint8Array ? undefined : input.body;
    await throwIfAborted(input.signal, body);
    const bucket = resolveBucket(config.bucket, input.context);
    const bucketName = resolveStringConfig(config.bucketName, input.context);
    const key = createObjectKey(config.basePath, input.key);
    const result = await bucket.put(key, input.body, {
      ...(input.condition === "create-only"
        ? { onlyIf: { etagDoesNotMatch: "*" } }
        : {}),
      ...(input.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: input.contentType } }),
      ...(input.metadata === undefined
        ? {}
        : { customMetadata: { ...input.metadata } }),
    });
    const storageUri = createR2Uri(bucketName, key);
    return result === null
      ? { kind: "already-exists", storageUri }
      : { kind: "stored", storageUri };
  },
  async head(input) {
    await throwIfAborted(input.signal);
    const bucket = resolveBucket(config.bucket, input.context);
    const bucketName = resolveStringConfig(config.bucketName, input.context);
    const object = await bucket.head(parseR2Uri(input.storageUri, bucketName));
    return object === null
      ? { kind: "not-found" }
      : {
          kind: "found",
          storageUri: input.storageUri,
          metadata: createObjectMetadata(object),
        };
  },
  async get(input) {
    await throwIfAborted(input.signal);
    const bucket = resolveBucket(config.bucket, input.context);
    const bucketName = resolveStringConfig(config.bucketName, input.context);
    const key = parseR2Uri(input.storageUri, bucketName);
    const object = await bucket.get(
      key,
      input.range === undefined
        ? undefined
        : {
            range: {
              offset: input.range.start,
              ...(input.range.end === undefined
                ? {}
                : { length: input.range.end - input.range.start + 1 }),
            },
          },
    );
    if (object === null) {
      return { kind: "not-found" };
    }
    const metadata = createObjectMetadata(object);
    const end =
      input.range?.end ??
      (input.range === undefined ? undefined : metadata.contentLength - 1);
    return {
      kind: "found",
      storageUri: input.storageUri,
      body: object.body,
      metadata,
      ...(input.range === undefined || end === undefined
        ? {}
        : {
            range: {
              start: input.range.start,
              end,
              totalLength: metadata.contentLength,
            },
          }),
    };
  },
  async delete(input) {
    await throwIfAborted(input.signal);
    const bucket = resolveBucket(config.bucket, input.context);
    const bucketName = resolveStringConfig(config.bucketName, input.context);
    const key = parseR2Uri(input.storageUri, bucketName);
    if ((await bucket.head(key)) === null) {
      return { kind: "not-found" };
    }
    await bucket.delete(key);
    return { kind: "deleted" };
  },
  ...(config.publicBaseUrl === undefined
    ? {}
    : {
        async issueDownload(input) {
          await throwIfAborted(input.signal);
          resolveBucket(config.bucket, input.context);
          return {
            kind: "issued",
            downloadUrl: await createDownloadUrl(
              config,
              input.storageUri,
              input.context,
            ),
          };
        },
      }),
  onUnmount() {},
});

export const r2Storage = (config: R2WorkerStorageConfig) =>
  createStoragePlugin({
    name: "r2Storage",
    protocol: "r2",
    plugin: () => createImplementation(config),
  });

export { createWorkerStorageContext } from "./workerContext";

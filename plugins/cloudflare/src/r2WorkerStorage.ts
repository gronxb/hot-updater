import { signToken } from "@hot-updater/js";
import {
  createStoragePlugin,
  type HotUpdaterContext,
  type RequestEnvContext,
  type StorageUploadSource,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageEnv {
  JWT_SECRET: string;
  BUCKET: {
    delete: (key: string | string[]) => Promise<void>;
    get: (key: string) => Promise<{
      arrayBuffer: () => Promise<ArrayBuffer>;
      text: () => Promise<string>;
    } | null>;
    head: (key: string) => Promise<unknown | null>;
    put: (
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | Blob,
      options?: {
        httpMetadata?: {
          contentType?: string;
        };
      },
    ) => Promise<unknown>;
  };
}

type ContextResolver<TContext, TValue> = (
  context?: HotUpdaterContext<TContext>,
) => TValue | Promise<TValue>;

export interface CloudflareWorkerStorageConfig<
  TContext extends RequestEnvContext<CloudflareWorkerStorageEnv>,
> {
  bucketName?: string;
  jwtSecret?: string | ContextResolver<TContext, string>;
  publicBaseUrl: string | ContextResolver<TContext, string>;
}

const resolveContextValue = async <TContext, TValue>(
  value: TValue | ContextResolver<TContext, TValue>,
  context?: HotUpdaterContext<TContext>,
) => {
  return typeof value === "function"
    ? await (value as ContextResolver<TContext, TValue>)(context)
    : value;
};

const resolveJwtSecretFromContext = (
  context?: RequestEnvContext<CloudflareWorkerStorageEnv>,
) => {
  const jwtSecret = context?.env?.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error(
      "r2WorkerStorage requires env.JWT_SECRET in the hot updater context.",
    );
  }

  return jwtSecret;
};

const resolveR2BucketFromContext = (
  context?: RequestEnvContext<CloudflareWorkerStorageEnv>,
) => {
  const bucket = context?.env?.BUCKET;

  if (!bucket) {
    throw new Error(
      "r2WorkerStorage requires env.BUCKET in the hot updater context.",
    );
  }

  return bucket;
};

const createPublicObjectPath = (storageUrl: URL) =>
  `${storageUrl.host}${storageUrl.pathname}`;

const createR2ObjectKey = (storageUrl: URL) =>
  storageUrl.pathname.replace(/^\/+/, "");

const createStorageUri = (bucketName: string, key: string) => {
  const normalizedKey = key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `r2://${bucketName}/${normalizedKey}`;
};

const createUploadBody = (source: StorageUploadSource) => {
  if (source.kind === "file") {
    throw new Error("r2WorkerStorage only supports bytes upload sources.");
  }

  return source.data;
};

export const r2WorkerStorage = <
  TContext extends RequestEnvContext<CloudflareWorkerStorageEnv> =
    RequestEnvContext<CloudflareWorkerStorageEnv>,
>(
  config: CloudflareWorkerStorageConfig<TContext>,
) => {
  return createStoragePlugin<CloudflareWorkerStorageConfig<TContext>, TContext>(
    {
      name: "r2WorkerStorage",
      supportedProtocol: "r2",
      factory: (config) => ({
        async delete(storageUri, context) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol !== "r2:") {
            throw new Error("Invalid R2 storage URI protocol");
          }

          const bucket = resolveR2BucketFromContext(context);
          await bucket.delete(createR2ObjectKey(storageUrl));
        },
        async exists(storageUri, context) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol !== "r2:") {
            throw new Error("Invalid R2 storage URI protocol");
          }

          const bucket = resolveR2BucketFromContext(context);
          return (await bucket.head(createR2ObjectKey(storageUrl))) !== null;
        },
        async upload(key, source, context) {
          const bucket = resolveR2BucketFromContext(context);
          const putOptions =
            source.kind === "bytes" && source.contentType
              ? {
                  httpMetadata: {
                    contentType: source.contentType,
                  },
                }
              : undefined;
          await bucket.put(key, createUploadBody(source), putOptions);

          return {
            storageUri: createStorageUri(config.bucketName ?? "bundles", key),
          };
        },
        async readBytes(storageUri, context) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol !== "r2:") {
            throw new Error("Invalid R2 storage URI protocol");
          }

          const bucket = resolveR2BucketFromContext(context);
          const object = await bucket.get(createR2ObjectKey(storageUrl));
          if (!object) {
            return null;
          }

          return object.arrayBuffer();
        },
        async readText(storageUri, context) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol !== "r2:") {
            throw new Error("Invalid R2 storage URI protocol");
          }

          const bucket = resolveR2BucketFromContext(context);
          const key = createR2ObjectKey(storageUrl);
          const object = await bucket.get(key);
          if (!object) {
            return null;
          }

          return object.text();
        },
        async getDownloadUrl(storageUri, context) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol !== "r2:") {
            throw new Error("Invalid R2 storage URI protocol");
          }

          const key = createPublicObjectPath(storageUrl);
          const [jwtSecret, publicBaseUrl] = await Promise.all([
            resolveContextValue(
              config.jwtSecret ?? resolveJwtSecretFromContext,
              context,
            ),
            resolveContextValue(config.publicBaseUrl, context),
          ]);
          const token = await signToken(key, jwtSecret);
          const url = new URL(publicBaseUrl);

          url.pathname = key;
          url.search = "";
          url.searchParams.set("token", token);

          return {
            fileUrl: url.toString(),
          };
        },
      }),
    },
  )(config);
};

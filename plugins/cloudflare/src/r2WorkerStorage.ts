import { signToken } from "@hot-updater/js";
import {
  createRuntimeStoragePlugin,
  type HotUpdaterContext,
  type RequestEnvContext,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageEnv {
  JWT_SECRET: string;
  BUCKET: {
    get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  };
}

type ContextResolver<TContext, TValue> = (
  context?: HotUpdaterContext<TContext>,
) => TValue | Promise<TValue>;

export interface CloudflareWorkerStorageConfig<
  TContext extends RequestEnvContext<CloudflareWorkerStorageEnv>,
> {
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

export const r2WorkerStorage = <
  TContext extends RequestEnvContext<CloudflareWorkerStorageEnv> =
    RequestEnvContext<CloudflareWorkerStorageEnv>,
>(
  config: CloudflareWorkerStorageConfig<TContext>,
) => {
  return createRuntimeStoragePlugin<
    CloudflareWorkerStorageConfig<TContext>,
    TContext
  >({
    name: "r2WorkerStorage",
    supportedProtocol: "r2",
    factory: (config) => ({
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
  })(config);
};

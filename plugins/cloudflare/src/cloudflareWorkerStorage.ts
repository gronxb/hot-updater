import { signToken } from "@hot-updater/js";
import type {
  HotUpdaterContext,
  RequestEnvContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageEnv {
  JWT_SECRET: string;
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
      "cloudflareWorkerStorage requires env.JWT_SECRET in the hot updater context.",
    );
  }

  return jwtSecret;
};

export const r2WorkerStorage = <
  TContext extends
    RequestEnvContext<CloudflareWorkerStorageEnv> = RequestEnvContext<CloudflareWorkerStorageEnv>,
>(
  config: CloudflareWorkerStorageConfig<TContext>,
) => {
  return (): StoragePlugin<TContext> => {
    return {
      name: "cloudflareWorkerStorage",
      supportedProtocol: "r2",
      async upload() {
        throw new Error(
          "cloudflareWorkerStorage does not support upload() in the worker runtime.",
        );
      },
      async delete() {
        throw new Error(
          "cloudflareWorkerStorage does not support delete() in the worker runtime.",
        );
      },
      async getDownloadUrl(storageUri, context) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = `${storageUrl.host}${storageUrl.pathname}`;
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
    };
  };
};

import { signToken } from "@hot-updater/js";
import type {
  HotUpdaterContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageEnv {
  JWT_SECRET: string;
}

type ContextResolver<TEnv, TValue> = (
  context: HotUpdaterContext<TEnv>,
) => TValue | Promise<TValue>;

export interface CloudflareWorkerStorageConfig<
  TEnv extends CloudflareWorkerStorageEnv,
> {
  jwtSecret?: string | ContextResolver<TEnv, string>;
  publicBaseUrl: string | ContextResolver<TEnv, string>;
}

const resolveContextValue = async <TEnv, TValue>(
  value: TValue | ContextResolver<TEnv, TValue>,
  context?: HotUpdaterContext<TEnv>,
) => {
  return typeof value === "function"
    ? await (value as ContextResolver<TEnv, TValue>)(context ?? {})
    : value;
};

const resolveJwtSecretFromContext = <TEnv extends CloudflareWorkerStorageEnv>(
  context?: HotUpdaterContext<TEnv>,
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
  TEnv extends CloudflareWorkerStorageEnv = CloudflareWorkerStorageEnv,
>(
  config: CloudflareWorkerStorageConfig<TEnv>,
) => {
  return (): StoragePlugin<TEnv> => {
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

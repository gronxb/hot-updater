import { signToken } from "@hot-updater/js";
import {
  createStoragePlugin,
  type StorageUploadSource,
} from "@hot-updater/plugin-core";
import { env } from "cloudflare:workers";

export interface CloudflareWorkerStorageEnv {
  HOT_UPDATER_PUBLIC_BASE_URL: string;
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

export interface CloudflareWorkerStorageConfig {
  bucketName?: string;
}

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

const getWorkerEnv = (): CloudflareWorkerStorageEnv => env;

export const r2WorkerStorage = (config: CloudflareWorkerStorageConfig = {}) => {
  return createStoragePlugin<CloudflareWorkerStorageConfig>({
    name: "r2WorkerStorage",
    supportedProtocol: "r2",
    factory: (config) => ({
      async delete({ storageUri }) {
        const workerEnv = getWorkerEnv();
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        await workerEnv.BUCKET.delete(createR2ObjectKey(storageUrl));
      },
      async exists({ storageUri }) {
        const workerEnv = getWorkerEnv();
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        return (
          (await workerEnv.BUCKET.head(createR2ObjectKey(storageUrl))) !== null
        );
      },
      async upload({ key, source }) {
        const workerEnv = getWorkerEnv();
        const putOptions =
          source.kind === "bytes" && source.contentType
            ? {
                httpMetadata: {
                  contentType: source.contentType,
                },
              }
            : undefined;
        await workerEnv.BUCKET.put(key, createUploadBody(source), putOptions);

        return {
          storageUri: createStorageUri(config.bucketName ?? "bundles", key),
        };
      },
      async readBytes({ storageUri }) {
        const workerEnv = getWorkerEnv();
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const object = await workerEnv.BUCKET.get(
          createR2ObjectKey(storageUrl),
        );
        if (!object) {
          return null;
        }

        return object.arrayBuffer();
      },
      async readText({ storageUri }) {
        const workerEnv = getWorkerEnv();
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = createR2ObjectKey(storageUrl);
        const object = await workerEnv.BUCKET.get(key);
        if (!object) {
          return null;
        }

        return object.text();
      },
      async getDownloadUrl({ storageUri }) {
        const workerEnv = getWorkerEnv();
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = createPublicObjectPath(storageUrl);
        const token = await signToken(key, workerEnv.JWT_SECRET);
        const url = new URL(workerEnv.HOT_UPDATER_PUBLIC_BASE_URL);

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

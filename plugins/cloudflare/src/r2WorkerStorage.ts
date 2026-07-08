import { signToken } from "@hot-updater/js";
import {
  createStoragePlugin,
  type StorageUploadSource,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageBucket {
  readonly delete: (key: string | string[]) => Promise<void>;
  readonly get: (key: string) => Promise<{
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
  } | null>;
  readonly head: (key: string) => Promise<unknown | null>;
  readonly put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | Blob,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ) => Promise<unknown>;
}

export interface CloudflareWorkerStorageEnv {
  readonly HOT_UPDATER_PUBLIC_BASE_URL: string;
  readonly JWT_SECRET: string;
  readonly BUCKET: CloudflareWorkerStorageBucket;
}

export interface CloudflareWorkerStorageConfig {
  readonly bucket: CloudflareWorkerStorageBucket;
  readonly jwtSecret: string;
  readonly publicBaseUrl: string;
  readonly bucketName?: string;
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

export const r2WorkerStorage = (config: CloudflareWorkerStorageConfig) => {
  return createStoragePlugin<CloudflareWorkerStorageConfig>({
    name: "r2WorkerStorage",
    supportedProtocol: "r2",
    factory: (config) => ({
      async delete({ storageUri }) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        await config.bucket.delete(createR2ObjectKey(storageUrl));
      },
      async exists({ storageUri }) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        return (
          (await config.bucket.head(createR2ObjectKey(storageUrl))) !== null
        );
      },
      async upload({ key, source }) {
        const putOptions =
          source.kind === "bytes" && source.contentType
            ? {
                httpMetadata: {
                  contentType: source.contentType,
                },
              }
            : undefined;
        await config.bucket.put(key, createUploadBody(source), putOptions);

        return {
          storageUri: createStorageUri(config.bucketName ?? "bundles", key),
        };
      },
      async readBytes({ storageUri }) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const object = await config.bucket.get(createR2ObjectKey(storageUrl));
        if (!object) {
          return null;
        }

        return object.arrayBuffer();
      },
      async readText({ storageUri }) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = createR2ObjectKey(storageUrl);
        const object = await config.bucket.get(key);
        if (!object) {
          return null;
        }

        return object.text();
      },
      async getDownloadUrl({ storageUri }) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = createPublicObjectPath(storageUrl);
        const token = await signToken(key, config.jwtSecret);
        const url = new URL(config.publicBaseUrl);

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

import { signToken } from "@hot-updater/js";
import type { StoragePlugin } from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageConfig {
  jwtSecret: string;
  publicBaseUrl: string;
}

export const r2WorkerStorage = (
  config: CloudflareWorkerStorageConfig,
) => {
  return (): StoragePlugin => {
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
      async getDownloadUrl(storageUri) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "r2:") {
          throw new Error("Invalid R2 storage URI protocol");
        }

        const key = `${storageUrl.host}${storageUrl.pathname}`;
        const token = await signToken(key, config.jwtSecret);
        const url = new URL(config.publicBaseUrl);

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

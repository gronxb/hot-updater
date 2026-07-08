import {
  createStoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import type { AppOptions } from "firebase-admin/app";

import { firebaseStorage } from "./firebaseStorage";

const trimTrailingSlash = (value: string) => {
  return value.endsWith("/") ? value.slice(0, -1) : value;
};

export interface FirebaseFunctionsStorageConfig extends AppOptions {
  storageBucket?: string;
  cdnUrl?: string;
}

const createFirebaseFunctionsStorage =
  createStoragePlugin<FirebaseFunctionsStorageConfig>({
    name: "firebaseFunctionsStorage",
    supportedProtocol: "gs",
    factory: (config) => {
      const fallbackStorage = firebaseStorage({
        ...config,
        storageBucket: config.storageBucket!,
      })();

      return {
        async readText({ storageUri }) {
          if (!fallbackStorage.readText) {
            throw new Error("firebaseStorage does not implement readText.");
          }

          return fallbackStorage.readText({ storageUri });
        },
        async getDownloadUrl({ storageUri }) {
          if (config.cdnUrl) {
            const storageUrl = new URL(storageUri);

            if (storageUrl.protocol === "gs:") {
              return {
                fileUrl: `${trimTrailingSlash(config.cdnUrl)}/${storageUrl.pathname.replace(/^\/+/, "")}`,
              };
            }
          }

          if (!fallbackStorage.getDownloadUrl) {
            throw new Error(
              "firebaseStorage does not implement getDownloadUrl.",
            );
          }

          return fallbackStorage.getDownloadUrl({ storageUri });
        },
      };
    },
  });

export const firebaseFunctionsStorage = (
  config: FirebaseFunctionsStorageConfig,
  hooks?: StoragePluginHooks,
) => {
  if (!config.storageBucket) {
    throw new Error(
      "firebaseFunctionsStorage requires storageBucket for runtime storage operations.",
    );
  }

  return createFirebaseFunctionsStorage(config, hooks);
};

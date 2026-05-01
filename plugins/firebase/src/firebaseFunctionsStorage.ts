import type {
  StoragePlugin,
  StoragePluginHooks,
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

export const firebaseFunctionsStorage = (
  config: FirebaseFunctionsStorageConfig,
  hooks?: StoragePluginHooks,
) => {
  const fallbackStorageFactory = config.storageBucket
    ? firebaseStorage(
        {
          ...config,
          storageBucket: config.storageBucket,
        },
        hooks,
      )
    : null;

  return (): StoragePlugin => {
    const fallbackStorage = fallbackStorageFactory?.() ?? null;

    return {
      name: "firebaseFunctionsStorage",
      supportedProtocol: "gs",
      async upload(key, filePath) {
        if (!fallbackStorage) {
          throw new Error(
            "firebaseFunctionsStorage requires storageBucket to support upload().",
          );
        }

        return fallbackStorage.upload(key, filePath);
      },
      async delete(storageUri) {
        if (!fallbackStorage) {
          throw new Error(
            "firebaseFunctionsStorage requires storageBucket to support delete().",
          );
        }

        return fallbackStorage.delete(storageUri);
      },
      async download(storageUri, filePath) {
        if (!fallbackStorage) {
          throw new Error(
            "firebaseFunctionsStorage requires storageBucket to support download().",
          );
        }

        return fallbackStorage.download(storageUri, filePath);
      },
      async getDownloadUrl(storageUri, context) {
        if (config.cdnUrl) {
          const storageUrl = new URL(storageUri);

          if (storageUrl.protocol === "gs:") {
            return {
              fileUrl: `${trimTrailingSlash(config.cdnUrl)}/${storageUrl.pathname.replace(/^\/+/, "")}`,
            };
          }
        }

        if (!fallbackStorage) {
          throw new Error(
            "firebaseFunctionsStorage requires storageBucket or cdnUrl to resolve download URLs.",
          );
        }

        return fallbackStorage.getDownloadUrl(storageUri, context);
      },
    };
  };
};

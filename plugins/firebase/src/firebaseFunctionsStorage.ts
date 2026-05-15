import {
  createRuntimeStoragePlugin,
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
  createRuntimeStoragePlugin<FirebaseFunctionsStorageConfig>({
    name: "firebaseFunctionsStorage",
    supportedProtocol: "gs",
    factory: (config) => {
      const fallbackStorage = firebaseStorage({
        ...config,
        storageBucket: config.storageBucket!,
      })();

      return {
        async readText(storageUri, context) {
          return fallbackStorage.profiles.runtime.readText(storageUri, context);
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

          return fallbackStorage.profiles.runtime.getDownloadUrl(
            storageUri,
            context,
          );
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
      "firebaseFunctionsStorage requires storageBucket for the runtime storage profile.",
    );
  }

  return createFirebaseFunctionsStorage(config, hooks);
};

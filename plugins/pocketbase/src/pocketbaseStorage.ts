import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";

import Pocketbase from "pocketbase";


export interface PocketbaseStorageConfig {
  host: string;
  publicUrl?: string;
  bundlesCollection?: string;
}
const publicUrl =  (config: PocketbaseStorageConfig, url: string) => {
  if (!config.publicUrl || !url.includes('/api/files')) {
    return url;
  }
  return `${config.publicUrl}/api/files${url.split('/api/files')[1]}`;
}


export const pocketbaseStorage =
  (config: PocketbaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {

    const pbClient = new Pocketbase(config.host)

    const bundlesCollection = pbClient.collection(config.bundlesCollection ?? "bundles")

    return {
      name: "pocketbaseStorage",
      async deleteBundle(bundleId: string) {

        const response = await bundlesCollection.delete(bundleId)

        if (!response) {
          const error = new Error(
            `Failed to delete bundle: ${response}`,
          );
          console.error(error);
          throw error;
        }

        return bundleId;
      },
      async uploadBundle(bundleId: string, bundlePath: string) {
        const fileContent = await fs.readFile(bundlePath);
        const contentType = "application/octet-stream";
        const filename = path.basename(bundlePath);

        const formData = new FormData();
        formData.append(
          "file",
          // @ts-expect-error type is not compatible with FormData
          new File([fileContent], filename, {type: contentType}),
        );

        formData.append("bundleId", bundleId);

        const createdRecord = await bundlesCollection.create(formData);
        const url = pbClient.files.getURL(createdRecord, createdRecord.file);
        
        hooks?.onStorageUploaded?.();

        return {
          fileUrl: publicUrl(config, url),
        };
      },
    };
  };

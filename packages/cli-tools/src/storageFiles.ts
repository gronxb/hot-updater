import fs from "node:fs/promises";
import path from "node:path";

import {
  getContentType,
  type StoragePluginWith,
  type StoragePutResult,
} from "@hot-updater/plugin-core";

export const putStorageFile = async (
  storage: StoragePluginWith<"put">,
  key: string,
  filePath: string,
): Promise<StoragePutResult> =>
  storage.put({
    key: path.posix.join(key, path.basename(filePath)),
    body: new Uint8Array(await fs.readFile(filePath)),
    contentType: getContentType(filePath),
  });

export const writeStorageFile = async (
  storage: StoragePluginWith<"get">,
  storageUri: string,
  filePath: string,
): Promise<void> => {
  const response = await storage.get(storageUri);
  if (response === null) {
    throw new Error(`Storage object not found: ${storageUri}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await response.arrayBuffer()));
};

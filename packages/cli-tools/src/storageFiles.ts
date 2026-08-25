import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  getContentType,
  type StoragePluginWith,
  type StoragePutResult,
} from "@hot-updater/plugin-core";

export const getStorageFileByteSize = async (filePath: string) => {
  const { size } = await fs.stat(filePath, { bigint: true });
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage file size must be a non-negative safe integer.");
  }
  return Number(size);
};

export const putStorageFile = async (
  storage: StoragePluginWith<"put">,
  key: string,
  filePath: string,
): Promise<StoragePutResult & { byteSize: number }> => {
  const byteSize = await getStorageFileByteSize(filePath);
  const source = createReadStream(filePath);

  try {
    const result = await storage.put({
      key: path.posix.join(key, path.basename(filePath)),
      body: Readable.toWeb(source) as ReadableStream<Uint8Array>,
      contentLength: byteSize,
      contentType: getContentType(filePath),
    });
    return { ...result, byteSize };
  } finally {
    source.destroy();
  }
};

export const writeStorageFile = async (
  storage: StoragePluginWith<"get">,
  storageUri: string,
  filePath: string,
): Promise<void> => {
  const { response } = await storage.get({ storageUri });
  if (response === null) {
    throw new Error(`Storage object not found: ${storageUri}`);
  }

  await writeStorageResponseFile(response, filePath);
};

export const writeStorageResponseFile = async (
  response: Response,
  filePath: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (response.body === null) {
    await fs.writeFile(filePath, new Uint8Array());
    return;
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(filePath),
    );
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
};

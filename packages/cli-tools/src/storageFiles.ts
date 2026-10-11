import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  getContentType,
  type StorageAdapterWith,
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
  storage: StorageAdapterWith<"put">,
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

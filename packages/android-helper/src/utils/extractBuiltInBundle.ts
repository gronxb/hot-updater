import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createInflateRaw } from "zlib";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const UINT32_MAX = 0xffffffff;
/** The end-of-central-directory record and the longest comment after it. */
const EOCD_SEARCH_LENGTH = 22 + 0xffff;

interface ZipEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

const read = async (
  file: fs.promises.FileHandle,
  offset: number,
  length: number,
) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
};

/** The central directory's offset and size, from its end record (ZIP64 too). */
const centralDirectoryOf = async (file: fs.promises.FileHandle) => {
  const { size } = await file.stat();
  const start = Math.max(0, size - EOCD_SEARCH_LENGTH);
  const tail = await read(file, start, size - start);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const entries = tail.readUInt16LE(i + 10);
    let directorySize = tail.readUInt32LE(i + 12);
    let directoryOffset = tail.readUInt32LE(i + 16);
    if (directoryOffset === UINT32_MAX || directorySize === UINT32_MAX) {
      const locator = i - 20;
      if (
        locator < 0 ||
        tail.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR_SIGNATURE
      ) {
        throw new Error("The archive's ZIP64 end record is missing.");
      }
      const record = await read(
        file,
        Number(tail.readBigUInt64LE(locator + 8)),
        56,
      );
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error("The archive's ZIP64 end record is invalid.");
      }
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    return { entries, directoryOffset, directorySize };
  }
  throw new Error("The artifact is not a zip archive.");
};

/** One entry's location, from the central directory, without reading the rest of the archive. */
const findEntry = async (
  file: fs.promises.FileHandle,
  name: string,
): Promise<ZipEntry | null> => {
  const { directoryOffset, directorySize } = await centralDirectoryOf(file);
  const directory = await read(file, directoryOffset, directorySize);
  for (let i = 0; i + 46 <= directory.length; ) {
    if (directory.readUInt32LE(i) !== CENTRAL_HEADER_SIGNATURE) break;
    const method = directory.readUInt16LE(i + 10);
    let compressedSize = directory.readUInt32LE(i + 20);
    const uncompressedSize = directory.readUInt32LE(i + 24);
    const nameLength = directory.readUInt16LE(i + 28);
    const extraLength = directory.readUInt16LE(i + 30);
    const commentLength = directory.readUInt16LE(i + 32);
    let localHeaderOffset = directory.readUInt32LE(i + 42);
    const entryName = directory.toString("utf8", i + 46, i + 46 + nameLength);
    if (entryName === name) {
      // ZIP64 sizes and offset follow in its extra field, in this order.
      const extra = directory.subarray(
        i + 46 + nameLength,
        i + 46 + nameLength + extraLength,
      );
      for (let j = 0; j + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(j);
        const length = extra.readUInt16LE(j + 2);
        if (id === ZIP64_EXTRA_ID) {
          let k = j + 4;
          if (uncompressedSize === UINT32_MAX) k += 8;
          if (compressedSize === UINT32_MAX) {
            compressedSize = Number(extra.readBigUInt64LE(k));
            k += 8;
          }
          if (localHeaderOffset === UINT32_MAX) {
            localHeaderOffset = Number(extra.readBigUInt64LE(k));
          }
        }
        j += 4 + length;
      }
      return { method, compressedSize, localHeaderOffset };
    }
    i += 46 + nameLength + extraLength + commentLength;
  }
  return null;
};

/**
 * Copies the JavaScript bundle React Native's Gradle build packed into an
 * `.apk` (`assets/index.android.bundle`) or an `.aab`
 * (`base/assets/index.android.bundle`) to `outputPath`: the built-in bundle,
 * byte for byte, which no rebuild reproduces. It reads only the archive's
 * directory and that entry, streamed, so a large artifact stays on disk.
 */
export const extractBuiltInBundle = async ({
  artifactPath,
  outputPath,
}: {
  artifactPath: string;
  outputPath: string;
}): Promise<void> => {
  const name =
    path.extname(artifactPath) === ".aab"
      ? "base/assets/index.android.bundle"
      : "assets/index.android.bundle";
  const file = await fs.promises.open(artifactPath, "r");
  let entry: ZipEntry | null;
  let dataOffset: number;
  try {
    entry = await findEntry(file, name);
    if (entry === null) {
      throw new Error(
        `${path.basename(artifactPath)} has no ${name}. A release build packs its JavaScript bundle there unless the app's react { bundleAssetName } names another file.`,
      );
    }
    const local = await read(file, entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`${path.basename(artifactPath)} has a corrupt ${name}.`);
    }
    dataOffset =
      entry.localHeaderOffset +
      30 +
      local.readUInt16LE(26) +
      local.readUInt16LE(28);
  } finally {
    await file.close();
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(
      `${path.basename(artifactPath)} stores ${name} with an unsupported compression method (${entry.method}).`,
    );
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  if (entry.compressedSize === 0) {
    await fs.promises.writeFile(outputPath, "");
    return;
  }
  const source = fs.createReadStream(artifactPath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  await (entry.method === 8
    ? pipeline(source, createInflateRaw(), fs.createWriteStream(outputPath))
    : pipeline(source, fs.createWriteStream(outputPath)));
};

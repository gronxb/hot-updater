import { type ByteSource, NativeArtifactError } from "./byteSource";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const UINT32_MAX = 0xffffffff;
/** The end-of-central-directory record and the longest comment after it. */
const EOCD_SEARCH_LENGTH = 22 + 0xffff;
/** How much compressed data one read takes. */
const READ_CHUNK = 1024 * 1024;

/** One file of a zip archive, from its central directory. */
export interface ZipEntry {
  readonly name: string;
  /** 0 stored, 8 deflated. */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const notZip = () =>
  new NativeArtifactError(
    "UNREADABLE",
    "The file is not a zip archive, as an .ipa, .aab or .apk is.",
  );

const u64 = (data: DataView, offset: number) =>
  Number(data.getBigUint64(offset, true));

/** The central directory's offset and size, from its end record (ZIP64 too). */
const centralDirectoryOf = async (source: ByteSource) => {
  const start = Math.max(0, source.size - EOCD_SEARCH_LENGTH);
  const tail = await source.read(start, source.size - start);
  const data = view(tail);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (data.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    let size = data.getUint32(i + 12, true);
    let offset = data.getUint32(i + 16, true);
    if (offset === UINT32_MAX || size === UINT32_MAX) {
      const locator = i - 20;
      if (
        locator < 0 ||
        data.getUint32(locator, true) !== ZIP64_EOCD_LOCATOR_SIGNATURE
      ) {
        throw notZip();
      }
      const record = view(await source.read(u64(data, locator + 8), 56));
      if (
        record.byteLength < 56 ||
        record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE
      ) {
        throw notZip();
      }
      size = u64(record, 40);
      offset = u64(record, 48);
    }
    if (offset + size > source.size) throw notZip();
    return { offset, size };
  }
  throw notZip();
};

/** Every entry of a zip archive, reading only its central directory. */
export const readZipDirectory = async (
  source: ByteSource,
): Promise<ZipEntry[]> => {
  const { offset, size } = await centralDirectoryOf(source);
  const directory = await source.read(offset, size);
  const data = view(directory);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i + 46 <= directory.length; ) {
    if (data.getUint32(i, true) !== CENTRAL_HEADER_SIGNATURE) break;
    const method = data.getUint16(i + 10, true);
    let compressedSize = data.getUint32(i + 20, true);
    let uncompressedSize = data.getUint32(i + 24, true);
    const nameLength = data.getUint16(i + 28, true);
    const extraLength = data.getUint16(i + 30, true);
    const commentLength = data.getUint16(i + 32, true);
    let localHeaderOffset = data.getUint32(i + 42, true);
    const nameStart = i + 46;
    const name = decoder.decode(
      directory.subarray(nameStart, nameStart + nameLength),
    );
    // ZIP64 sizes and offset follow in its extra field, in this order.
    const extraStart = nameStart + nameLength;
    for (let j = extraStart; j + 4 <= extraStart + extraLength; ) {
      const id = data.getUint16(j, true);
      const length = data.getUint16(j + 2, true);
      if (id === ZIP64_EXTRA_ID) {
        let k = j + 4;
        if (uncompressedSize === UINT32_MAX) {
          uncompressedSize = u64(data, k);
          k += 8;
        }
        if (compressedSize === UINT32_MAX) {
          compressedSize = u64(data, k);
          k += 8;
        }
        if (localHeaderOffset === UINT32_MAX) {
          localHeaderOffset = u64(data, k);
        }
      }
      j += 4 + length;
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    i = extraStart + extraLength + commentLength;
  }
  return entries;
};

/** Where an entry's data starts, past its local header. */
const dataOffsetOf = async (source: ByteSource, entry: ZipEntry) => {
  const local = view(await source.read(entry.localHeaderOffset, 30));
  if (
    local.byteLength < 30 ||
    local.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The archive's ${entry.name} is corrupt.`,
    );
  }
  return (
    entry.localHeaderOffset +
    30 +
    local.getUint16(26, true) +
    local.getUint16(28, true)
  );
};

/**
 * An entry's uncompressed bytes as a stream, read from the source a chunk at
 * a time, so a large entry is never held whole.
 */
export const openZipEntry = async (
  source: ByteSource,
  entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> => {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The archive stores ${entry.name} with an unsupported compression method (${entry.method}).`,
    );
  }
  const start = await dataOffsetOf(source, entry);
  const end = start + entry.compressedSize;
  let position = start;
  const compressed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position >= end) {
        controller.close();
        return;
      }
      const chunk = await source.read(
        position,
        Math.min(READ_CHUNK, end - position),
      );
      if (chunk.byteLength === 0) {
        controller.error(
          new NativeArtifactError(
            "UNREADABLE",
            `The archive ends inside ${entry.name}.`,
          ),
        );
        return;
      }
      position += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return entry.method === 0
    ? compressed
    : compressed.pipeThrough(
        new DecompressionStream("deflate-raw") as unknown as TransformStream<
          Uint8Array,
          Uint8Array
        >,
      );
};

/**
 * The uncompressed bytes in `[start, end)` of an entry, which stops
 * inflating once it has them: a Mach-O header without the rest of the
 * binary.
 */
export const readZipEntryRange = async (
  source: ByteSource,
  entry: ZipEntry,
  start: number,
  end: number,
): Promise<Uint8Array> => {
  const length = Math.max(0, Math.min(end, entry.uncompressedSize) - start);
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const reader = (await openZipEntry(source, entry)).getReader();
  let position = 0;
  let written = 0;
  try {
    while (written < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const from = Math.max(start - position, 0);
      const to = Math.min(start + length - position, value.byteLength);
      if (from < to) {
        out.set(value.subarray(from, to), position + from - start);
        written += to - from;
      }
      position += value.byteLength;
    }
  } catch (error) {
    throw error instanceof NativeArtifactError
      ? error
      : new NativeArtifactError(
          "UNREADABLE",
          `The archive's ${entry.name} can't be decompressed: ${error instanceof Error ? error.message : String(error)}.`,
        );
  } finally {
    await reader.cancel().catch(() => {});
  }
  return written === length ? out : out.subarray(0, written);
};

/** An entry's uncompressed bytes. */
export const readZipEntry = (
  source: ByteSource,
  entry: ZipEntry,
): Promise<Uint8Array> =>
  readZipEntryRange(source, entry, 0, entry.uncompressedSize);

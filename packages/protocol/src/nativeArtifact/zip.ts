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

const MiB = 1024 * 1024;
/**
 * What an archive may hold before it is refused as no artifact: an upload is
 * untrusted, so a crafted directory or entry (a zip bomb) stops here, not
 * after filling memory.
 */
export const ZIP_LIMITS = {
  /** The central directory. */
  directoryBytes: 64 * MiB,
  entries: 500_000,
  /** An entry streamed out whole, such as the built-in bundle. */
  entryBytes: 1024 * MiB,
} as const;

const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** One file of a zip archive, from its central directory. */
export interface ZipEntry {
  readonly name: string;
  /**
   * A name no artifact holds: absolute, with a `..` segment, a backslash or
   * a NUL. No lookup matches it.
   */
  readonly unsafe: boolean;
  /** A symbolic link, whose data is a path, not a file's bytes. */
  readonly symlink: boolean;
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
  if (size > ZIP_LIMITS.directoryBytes) {
    throw new NativeArtifactError(
      "UNREADABLE",
      "The archive's directory is larger than any artifact's.",
    );
  }
  const directory = await source.read(offset, size);
  const data = view(directory);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i + 46 <= directory.length; ) {
    if (data.getUint32(i, true) !== CENTRAL_HEADER_SIGNATURE) break;
    if (entries.length >= ZIP_LIMITS.entries) {
      throw new NativeArtifactError(
        "UNREADABLE",
        "The archive holds more entries than any artifact.",
      );
    }
    const madeBy = data.getUint16(i + 4, true);
    const externalAttributes = data.getUint32(i + 38, true);
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
    const segments = name.split("/");
    entries.push({
      name,
      unsafe:
        name.startsWith("/") ||
        /^[A-Za-z]:/u.test(name) ||
        name.includes("\\") ||
        name.includes("\0") ||
        segments.includes(".."),
      symlink:
        madeBy >> 8 === UNIX_HOST &&
        ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    i = extraStart + extraLength + commentLength;
  }
  return entries;
};

/**
 * The one entry an artifact's reader takes by `name`: a symbolic link, or a
 * name the archive holds twice, which could hand the reader other bytes
 * than an installer reads, is refused. Unsafe names match nothing.
 */
export const findZipEntry = (
  entries: readonly ZipEntry[],
  match: string | ((name: string) => boolean),
): ZipEntry | undefined => {
  const test =
    typeof match === "string" ? (name: string) => name === match : match;
  const found = entries.filter(({ name, unsafe }) => !unsafe && test(name));
  for (const entry of found) assertReadable(entry);
  if (typeof match === "string" && found.length > 1) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The archive holds ${match} more than once.`,
    );
  }
  return found[0];
};

/** Every safe entry `match` takes, each a file the reader may read. */
export const filterZipEntries = (
  entries: readonly ZipEntry[],
  match: (name: string) => boolean,
): ZipEntry[] => {
  const found = entries.filter(({ name, unsafe }) => !unsafe && match(name));
  for (const entry of found) assertReadable(entry);
  return found;
};

const assertReadable = (entry: ZipEntry) => {
  if (entry.symlink) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The archive's ${entry.name} is a symbolic link, not a file.`,
    );
  }
};

/** How much an artifact's reading may inflate in all, and by when. */
export interface ZipReadBudget {
  /** Uncompressed bytes left to inflate, across every read. */
  remaining: number;
  /** Date.now() past which reading stops. */
  readonly deadline: number;
}

const tooLarge = (entry: ZipEntry, limit: number) =>
  new NativeArtifactError(
    "UNREADABLE",
    `The archive's ${entry.name} is larger than ${Math.round(limit / MiB)} MB, more than any artifact's.`,
  );

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
  {
    maxBytes = ZIP_LIMITS.entryBytes,
  }: {
    /** The most the entry may inflate to, whatever its header says. */
    readonly maxBytes?: number;
  } = {},
): Promise<ReadableStream<Uint8Array>> => {
  assertReadable(entry);
  if (entry.unsafe) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The archive's entry ${JSON.stringify(entry.name)} has a name no artifact holds.`,
    );
  }
  if (entry.uncompressedSize > maxBytes) throw tooLarge(entry, maxBytes);
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
  const inflated =
    entry.method === 0
      ? compressed
      : compressed.pipeThrough(
          new DecompressionStream("deflate-raw") as unknown as TransformStream<
            Uint8Array,
            Uint8Array
          >,
        );
  // An entry that inflates past the size its header declares is a bomb.
  const limit = Math.min(entry.uncompressedSize, maxBytes);
  let produced = 0;
  return inflated.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        produced += chunk.byteLength;
        if (produced > limit) {
          controller.error(
            new NativeArtifactError(
              "UNREADABLE",
              `The archive's ${entry.name} inflates past the size it declares.`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
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
  budget?: ZipReadBudget,
): Promise<Uint8Array> => {
  const length = Math.max(0, Math.min(end, entry.uncompressedSize) - start);
  if (budget !== undefined && start + length > budget.remaining) {
    throw new NativeArtifactError(
      "UNREADABLE",
      "The artifact inflates to more than any artifact's.",
    );
  }
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const reader = (await openZipEntry(source, entry)).getReader();
  let position = 0;
  let written = 0;
  try {
    while (written < length) {
      if (budget !== undefined && Date.now() > budget.deadline) {
        throw new NativeArtifactError(
          "UNREADABLE",
          "Reading the artifact took too long.",
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (budget !== undefined) budget.remaining -= value.byteLength;
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

/** An entry's uncompressed bytes, refused past `maxBytes`. */
export const readZipEntry = (
  source: ByteSource,
  entry: ZipEntry,
  maxBytes: number,
  budget?: ZipReadBudget,
): Promise<Uint8Array> => {
  if (entry.uncompressedSize > maxBytes) throw tooLarge(entry, maxBytes);
  return readZipEntryRange(source, entry, 0, entry.uncompressedSize, budget);
};

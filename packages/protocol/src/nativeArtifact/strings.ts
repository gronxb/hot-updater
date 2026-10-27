import { NativeArtifactError } from "./byteSource";

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Bytes that are all ASCII, as text; null otherwise. */
const asciiOf = (bytes: Uint8Array): string | null => {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0 || byte >= 0x80) return null;
    text += String.fromCharCode(byte);
  }
  return text;
};

/**
 * The string constants of a dex file with one of `lengths`, from its string
 * pool: every string literal the app's code holds, each one whole. R8
 * renames and inlines classes, but never drops a literal the code returns,
 * so the pool still holds a value the native SDK compiled in.
 */
export const readDexStrings = (
  dex: Uint8Array,
  lengths: ReadonlySet<number>,
): string[] => {
  const data = view(dex);
  if (
    dex.byteLength < 0x70 ||
    asciiOf(dex.subarray(0, 3)) !== "dex" ||
    dex[3] !== 0x0a
  ) {
    throw new NativeArtifactError("UNREADABLE", "A dex file is corrupt.");
  }
  const count = data.getUint32(0x38, true);
  const idsOffset = data.getUint32(0x3c, true);
  if (idsOffset + count * 4 > dex.byteLength) {
    throw new NativeArtifactError("UNREADABLE", "A dex file is corrupt.");
  }
  const strings: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let offset = data.getUint32(idsOffset + i * 4, true);
    // The UTF-16 length as ULEB128, then MUTF-8 bytes and a NUL. An ASCII
    // string's byte length is its UTF-16 length.
    let utf16Length = 0;
    for (let shift = 0; offset < dex.byteLength; shift += 7) {
      const byte = dex[offset++]!;
      utf16Length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0 || shift > 28) break;
    }
    if (!lengths.has(utf16Length)) continue;
    const end = offset + utf16Length;
    if (end >= dex.byteLength || dex[end] !== 0) continue;
    const text = asciiOf(dex.subarray(offset, end));
    if (text !== null) strings.push(text);
  }
  return strings;
};

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const CPU_TYPE_ARM64 = 0x0100000c;

/** Reads `[start, end)` of a binary. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

const nameAt = (bytes: Uint8Array, offset: number) => {
  let name = "";
  for (let i = offset; i < offset + 16 && bytes[i] !== 0; i += 1) {
    name += String.fromCharCode(bytes[i]!);
  }
  return name;
};

/** The slice of a universal binary to read: arm64's, else the first. */
const sliceOf = async (read: RangeReader) => {
  const head = await read(0, 4096);
  if (head.byteLength < 8) return null;
  const data = view(head);
  const magic = data.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return 0;
  const count = data.getUint32(4, false);
  const size = magic === FAT_MAGIC ? 20 : 32;
  let first: number | null = null;
  for (let i = 0; i < count && 8 + (i + 1) * size <= head.byteLength; i += 1) {
    const at = 8 + i * size;
    const offset =
      magic === FAT_MAGIC
        ? data.getUint32(at + 8, false)
        : Number(data.getBigUint64(at + 8, false));
    if (data.getUint32(at, false) === CPU_TYPE_ARM64) return offset;
    first ??= offset;
  }
  return first;
};

/**
 * The C string literals of a Mach-O binary with one of `lengths`, from its
 * `__TEXT,__cstring` section, each one whole: the literals an Objective-C or
 * Swift source compiled in. A universal binary is read by its arm64 slice.
 * A file that is no Mach-O binary holds none.
 */
export const readMachOStrings = async (
  read: RangeReader,
  lengths: ReadonlySet<number>,
): Promise<string[]> => {
  const base = await sliceOf(read);
  if (base === null) return [];
  const header = await read(base, base + 32);
  if (header.byteLength < 28) return [];
  const data = view(header);
  const magic = data.getUint32(0, true);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return [];
  const is64 = magic === MH_MAGIC_64;
  const headerSize = is64 ? 32 : 28;
  const commandCount = data.getUint32(16, true);
  const commandsSize = data.getUint32(20, true);
  const commands = await read(
    base + headerSize,
    base + headerSize + commandsSize,
  );
  const cmds = view(commands);
  let section: { offset: number; size: number } | null = null;
  for (
    let i = 0, at = 0;
    i < commandCount && at + 8 <= commands.byteLength && section === null;
    i += 1
  ) {
    const cmd = cmds.getUint32(at, true);
    const cmdSize = cmds.getUint32(at + 4, true);
    if (cmdSize < 8) break;
    if (
      (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) &&
      nameAt(commands, at + 8) === "__TEXT"
    ) {
      const sectionCount = cmds.getUint32(at + (is64 ? 64 : 48), true);
      const first = at + (is64 ? 72 : 56);
      const sectionSize = is64 ? 80 : 68;
      for (let s = 0; s < sectionCount; s += 1) {
        const sec = first + s * sectionSize;
        if (sec + sectionSize > commands.byteLength) break;
        if (nameAt(commands, sec) !== "__cstring") continue;
        section = is64
          ? {
              size: Number(cmds.getBigUint64(sec + 40, true)),
              offset: cmds.getUint32(sec + 48, true),
            }
          : {
              size: cmds.getUint32(sec + 36, true),
              offset: cmds.getUint32(sec + 40, true),
            };
        break;
      }
    }
    at += cmdSize;
  }
  if (section === null || section.size === 0) return [];
  const cstrings = await read(
    base + section.offset,
    base + section.offset + section.size,
  );
  const strings: string[] = [];
  for (let start = 0; start < cstrings.byteLength; ) {
    let end = cstrings.indexOf(0, start);
    if (end === -1) end = cstrings.byteLength;
    if (lengths.has(end - start)) {
      const text = asciiOf(cstrings.subarray(start, end));
      if (text !== null) strings.push(text);
    }
    start = end + 1;
  }
  return strings;
};

import { NativeArtifactError } from "./byteSource";

/** A plist value: what an Info.plist holds. */
export type PlistValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

/** How deep a plist nests: an Info.plist nests a few levels. */
const MAX_DEPTH = 64;

const corrupt = () =>
  new NativeArtifactError("UNREADABLE", "The app's Info.plist is corrupt.");

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A big-endian unsigned integer of `size` bytes. */
const uintAt = (bytes: Uint8Array, offset: number, size: number) => {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + bytes[offset + i]!;
  return value;
};

/** A binary property list (`bplist00`), as Xcode writes an app's Info.plist. */
const parseBinaryPlist = (bytes: Uint8Array): PlistValue => {
  if (bytes.byteLength < 40) throw corrupt();
  const trailer = bytes.byteLength - 32;
  const offsetSize = bytes[trailer + 6]!;
  const refSize = bytes[trailer + 7]!;
  const objectCount = uintAt(bytes, trailer + 8, 8);
  const top = uintAt(bytes, trailer + 16, 8);
  const tableOffset = uintAt(bytes, trailer + 24, 8);
  // Every width and count is checked against the file before anything is
  // allocated or iterated: a few crafted bytes can't declare a million
  // references.
  if (
    offsetSize < 1 ||
    offsetSize > 8 ||
    refSize < 1 ||
    refSize > 8 ||
    objectCount < 1 ||
    top >= objectCount ||
    tableOffset < 8 ||
    tableOffset + objectCount * offsetSize > trailer
  ) {
    throw corrupt();
  }
  const data = view(bytes);
  const seen = new Set<number>();
  // Each object is parsed once: an array or a dictionary that references
  // another object many times shares it, so a crafted plist can't expand
  // exponentially.
  const parsed = new Map<number, PlistValue>();

  const parse = (ref: number): PlistValue => {
    const done = parsed.get(ref);
    if (done !== undefined) return done;
    if (ref >= objectCount || seen.has(ref) || seen.size > MAX_DEPTH) {
      throw corrupt();
    }
    const value = parseObject(ref);
    parsed.set(ref, value);
    return value;
  };

  const parseObject = (ref: number): PlistValue => {
    const offset = uintAt(bytes, tableOffset + ref * offsetSize, offsetSize);
    // Objects lie between the header and the offset table.
    if (offset < 8 || offset >= tableOffset) throw corrupt();
    const marker = bytes[offset]!;
    const kind = marker >> 4;
    const info = marker & 0x0f;
    /** `count` units of `unit` bytes from `start`, which must fit the objects. */
    const fits = (start: number, count: number, unit: number) => {
      if (start + count * unit > tableOffset) throw corrupt();
    };
    /**
     * A length in the marker, or in the integer object after it, and where
     * its `unit`-byte items start, all of which must fit the objects.
     */
    const lengthAt = (unit: number): [length: number, start: number] => {
      let length = info;
      let start = offset + 1;
      if (info === 0x0f) {
        const sizeMarker = bytes[offset + 1]!;
        if (sizeMarker >> 4 !== 0x1 || (sizeMarker & 0x0f) > 3) {
          throw corrupt();
        }
        const size = 1 << (sizeMarker & 0x0f);
        fits(offset + 2, size, 1);
        length = uintAt(bytes, offset + 2, size);
        start = offset + 2 + size;
      }
      fits(start, length, unit);
      return [length, start];
    };
    switch (kind) {
      case 0x0:
        return info === 0x09 ? true : info === 0x08 ? false : null;
      case 0x1: {
        if (info > 3) throw corrupt();
        const size = 1 << info;
        fits(offset + 1, size, 1);
        return size === 8
          ? Number(data.getBigInt64(offset + 1, false))
          : uintAt(bytes, offset + 1, size);
      }
      case 0x2:
        if (info !== 2 && info !== 3) throw corrupt();
        fits(offset + 1, 1 << info, 1);
        return info === 2
          ? data.getFloat32(offset + 1, false)
          : data.getFloat64(offset + 1, false);
      case 0x3:
        fits(offset + 1, 8, 1);
        return data.getFloat64(offset + 1, false);
      case 0x4: {
        const [length, start] = lengthAt(1);
        return bytes.slice(start, start + length);
      }
      case 0x5: {
        const [length, start] = lengthAt(1);
        return new TextDecoder("latin1").decode(
          bytes.subarray(start, start + length),
        );
      }
      case 0x6: {
        const [length, start] = lengthAt(2);
        let text = "";
        for (let i = 0; i < length; i += 1) {
          text += String.fromCharCode(data.getUint16(start + i * 2, false));
        }
        return text;
      }
      case 0x8:
        if (info > 7) throw corrupt();
        fits(offset + 1, info + 1, 1);
        return uintAt(bytes, offset + 1, info + 1);
      case 0xa:
      case 0xc: {
        const [length, start] = lengthAt(refSize);
        seen.add(ref);
        const items: PlistValue[] = [];
        for (let i = 0; i < length; i += 1) {
          items.push(parse(uintAt(bytes, start + i * refSize, refSize)));
        }
        seen.delete(ref);
        return items;
      }
      case 0xd: {
        // Keys, then values.
        const [length, start] = lengthAt(2 * refSize);
        seen.add(ref);
        const dict: { [key: string]: PlistValue } = Object.create(null);
        for (let i = 0; i < length; i += 1) {
          const key = parse(uintAt(bytes, start + i * refSize, refSize));
          const value = parse(
            uintAt(bytes, start + (length + i) * refSize, refSize),
          );
          if (typeof key !== "string") throw corrupt();
          dict[key] = value;
        }
        seen.delete(ref);
        return dict;
      }
      default:
        throw corrupt();
    }
  };
  return parse(top);
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/giu, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? whole;
  });

/** An XML property list, as some tools leave an app's Info.plist. */
const parseXmlPlist = (text: string): PlistValue => {
  // Tags and the text between them, without comments or declarations.
  const tokens = text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<\?[\s\S]*?\?>/gu, "")
    .replace(/<!DOCTYPE[^>]*>/giu, "")
    .split(/(<[^>]+>)/u);
  let i = 0;
  const nextTag = (): string => {
    while (i < tokens.length) {
      const token = tokens[i++]!;
      if (token.startsWith("<")) return token;
      if (token.trim() !== "") throw corrupt();
    }
    throw corrupt();
  };
  const textUntil = (close: string): string => {
    let value = "";
    while (i < tokens.length && tokens[i] !== close) value += tokens[i++];
    if (tokens[i++] !== close) throw corrupt();
    return decodeEntities(value);
  };
  let depth = 0;
  const parseValue = (tag: string): PlistValue => {
    if (depth > MAX_DEPTH) throw corrupt();
    const name = /^<\s*([\w]+)/u.exec(tag)?.[1];
    const empty = tag.endsWith("/>");
    switch (name) {
      case "string":
        return empty ? "" : textUntil("</string>");
      case "integer":
        return Number(textUntil("</integer>"));
      case "real":
        return Number(textUntil("</real>"));
      case "true":
        return true;
      case "false":
        return false;
      case "date":
        return textUntil("</date>");
      case "data":
        return textUntil("</data>").replace(/\s+/gu, "");
      case "array": {
        const items: PlistValue[] = [];
        if (empty) return items;
        depth += 1;
        for (let next = nextTag(); next !== "</array>"; next = nextTag()) {
          items.push(parseValue(next));
        }
        depth -= 1;
        return items;
      }
      case "dict": {
        const dict: { [key: string]: PlistValue } = Object.create(null);
        if (empty) return dict;
        depth += 1;
        for (let next = nextTag(); next !== "</dict>"; next = nextTag()) {
          if (next !== "<key>") throw corrupt();
          const key = textUntil("</key>");
          dict[key] = parseValue(nextTag());
        }
        depth -= 1;
        return dict;
      }
      default:
        throw corrupt();
    }
  };
  let tag = nextTag();
  if (/^<plist\b/u.test(tag)) tag = nextTag();
  return parseValue(tag);
};

/** A property list, binary or XML, as a JavaScript value. */
export const parsePlist = (bytes: Uint8Array): PlistValue => {
  if (new TextDecoder().decode(bytes.subarray(0, 8)) === "bplist00") {
    return parseBinaryPlist(bytes);
  }
  return parseXmlPlist(new TextDecoder().decode(bytes));
};

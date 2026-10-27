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
  if (tableOffset + objectCount * offsetSize > trailer) throw corrupt();
  const data = view(bytes);
  const seen = new Set<number>();

  const parse = (ref: number): PlistValue => {
    if (ref >= objectCount || seen.has(ref) || seen.size > MAX_DEPTH) {
      throw corrupt();
    }
    const offset = uintAt(bytes, tableOffset + ref * offsetSize, offsetSize);
    const marker = bytes[offset]!;
    const kind = marker >> 4;
    const info = marker & 0x0f;
    /** A length in the marker, or in the integer object after it. */
    const lengthAt = (): [length: number, start: number] => {
      if (info !== 0x0f) return [info, offset + 1];
      const size = 1 << (bytes[offset + 1]! & 0x0f);
      return [uintAt(bytes, offset + 2, size), offset + 2 + size];
    };
    switch (kind) {
      case 0x0:
        return info === 0x09 ? true : info === 0x08 ? false : null;
      case 0x1: {
        const size = 1 << info;
        return size === 8
          ? Number(data.getBigInt64(offset + 1, false))
          : uintAt(bytes, offset + 1, size);
      }
      case 0x2:
        return info === 2
          ? data.getFloat32(offset + 1, false)
          : data.getFloat64(offset + 1, false);
      case 0x3:
        return data.getFloat64(offset + 1, false);
      case 0x4: {
        const [length, start] = lengthAt();
        return bytes.slice(start, start + length);
      }
      case 0x5: {
        const [length, start] = lengthAt();
        return new TextDecoder("latin1").decode(
          bytes.subarray(start, start + length),
        );
      }
      case 0x6: {
        const [length, start] = lengthAt();
        let text = "";
        for (let i = 0; i < length; i += 1) {
          text += String.fromCharCode(data.getUint16(start + i * 2, false));
        }
        return text;
      }
      case 0x8:
        return uintAt(bytes, offset + 1, info + 1);
      case 0xa:
      case 0xc: {
        const [length, start] = lengthAt();
        seen.add(ref);
        const items: PlistValue[] = [];
        for (let i = 0; i < length; i += 1) {
          items.push(parse(uintAt(bytes, start + i * refSize, refSize)));
        }
        seen.delete(ref);
        return items;
      }
      case 0xd: {
        const [length, start] = lengthAt();
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

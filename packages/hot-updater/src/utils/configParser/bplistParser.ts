// Binary plist parser
// Adapted from https://github.com/joeferner/node-bplist-parser

const MAX_OBJECT_SIZE = 100 * 1000 * 1000; // 100MB
const MAX_OBJECT_COUNT = 32768;

// EPOCH = 2001-01-01 00:00:00 GMT
const EPOCH = 978307200000;

/**
 * UID object for binary plist
 */
export class UID {
  UID: number;

  constructor(id: number) {
    this.UID = id;
  }
}

/**
 * Parses a binary plist buffer
 * @param buffer - The binary plist buffer to parse
 * @returns Array containing the parsed plist object
 */
export function parseBuffer(buffer: Buffer): unknown[] {
  // Check header
  const header = buffer.subarray(0, "bplist".length).toString("utf8");
  if (header !== "bplist") {
    throw new Error("Invalid binary plist. Expected 'bplist' at offset 0.");
  }

  // Handle trailer, last 32 bytes of the file
  const trailer = buffer.subarray(buffer.length - 32, buffer.length);
  // 6 null bytes (index 0 to 5)
  const offsetSize = trailer.readUInt8(6);
  const objectRefSize = trailer.readUInt8(7);
  const numObjects = readUInt64BE(trailer, 8);
  const topObject = readUInt64BE(trailer, 16);
  const offsetTableOffset = readUInt64BE(trailer, 24);

  if (numObjects > MAX_OBJECT_COUNT) {
    throw new Error("maxObjectCount exceeded");
  }

  // Handle offset table
  const offsetTable: number[] = [];

  for (let i = 0; i < numObjects; i++) {
    const offsetBytes = buffer.subarray(
      offsetTableOffset + i * offsetSize,
      offsetTableOffset + (i + 1) * offsetSize,
    );
    offsetTable[i] = readUInt(offsetBytes, 0);
  }

  /**
   * Parses an object inside the currently parsed binary property list.
   * For the format specification check
   * https://www.opensource.apple.com/source/CF/CF-635/CFBinaryPList.c
   */
  function parseObject(tableOffset: number): unknown {
    const offset = offsetTable[tableOffset];
    if (offset === undefined) {
      throw new Error(`Invalid offset for object at index ${tableOffset}`);
    }
    const type = buffer[offset];
    if (type === undefined) {
      throw new Error(`Invalid type byte at offset ${offset}`);
    }
    const objType = (type & 0xf0) >> 4; // First 4 bits
    const objInfo = type & 0x0f; // Second 4 bits

    // Use local offset variable to help TypeScript understand it's defined
    const currentOffset = offset;

    switch (objType) {
      case 0x0:
        return parseSimple();
      case 0x1:
        return parseInteger();
      case 0x8:
        return parseUID();
      case 0x2:
        return parseReal();
      case 0x3:
        return parseDate();
      case 0x4:
        return parseData();
      case 0x5: // ASCII
        return parsePlistString(false);
      case 0x6: // UTF-16
        return parsePlistString(true);
      case 0xa:
        return parseArray();
      case 0xd:
        return parseDictionary();
      default:
        throw new Error(`Unhandled type 0x${objType.toString(16)}`);
    }

    function parseSimple(): null | boolean {
      switch (objInfo) {
        case 0x0: // null
          return null;
        case 0x8: // false
          return false;
        case 0x9: // true
          return true;
        case 0xf: // filler byte
          return null;
        default:
          throw new Error(`Unhandled simple type 0x${objType.toString(16)}`);
      }
    }

    function bufferToHexString(buf: Buffer): string {
      let str = "";
      let i: number;
      for (i = 0; i < buf.length; i++) {
        const byte = buf[i];
        if (byte === undefined || byte !== 0x00) {
          break;
        }
      }
      for (; i < buf.length; i++) {
        const byte = buf[i];
        if (byte === undefined) {
          break;
        }
        const part = `00${byte.toString(16)}`;
        str += part.substr(part.length - 2);
      }
      return str;
    }

    function parseInteger(): number | bigint {
      const length = 2 ** objInfo;
      if (length < MAX_OBJECT_SIZE) {
        const data = buffer.subarray(
          currentOffset + 1,
          currentOffset + 1 + length,
        );
        if (length === 16) {
          const str = bufferToHexString(data);
          return BigInt(`0x${str}`);
        }
        return data.reduce((acc, curr) => {
          acc <<= 8;
          acc |= curr & 255;
          return acc;
        });
      }
      throw new Error(
        `Too little heap space available! Wanted to read ${length} bytes, but only ${MAX_OBJECT_SIZE} are available.`,
      );
    }

    function parseUID(): UID {
      const length = objInfo + 1;
      if (length < MAX_OBJECT_SIZE) {
        return new UID(
          readUInt(
            buffer.subarray(currentOffset + 1, currentOffset + 1 + length),
          ),
        );
      }
      throw new Error(
        `Too little heap space available! Wanted to read ${length} bytes, but only ${MAX_OBJECT_SIZE} are available.`,
      );
    }

    function parseReal(): number {
      const length = 2 ** objInfo;
      if (length >= MAX_OBJECT_SIZE) {
        throw new Error(
          `Too little heap space available! Wanted to read ${length} bytes, but only ${MAX_OBJECT_SIZE} are available.`,
        );
      }
      const realBuffer = buffer.subarray(
        currentOffset + 1,
        currentOffset + 1 + length,
      );
      if (length === 4) {
        return realBuffer.readFloatBE(0);
      }
      if (length === 8) {
        return realBuffer.readDoubleBE(0);
      }
      throw new Error(`Unexpected real number length: ${length}`);
    }

    function parseDate(): Date {
      const dateBuffer = buffer.subarray(currentOffset + 1, currentOffset + 9);
      return new Date(EPOCH + 1000 * dateBuffer.readDoubleBE(0));
    }

    function parseData(): Buffer {
      let dataoffset = 1;
      let length = objInfo;
      if (objInfo === 0xf) {
        const int_type = buffer[currentOffset + 1];
        if (int_type === undefined) {
          throw new Error("Missing integer type byte");
        }
        const intType = (int_type & 0xf0) / 0x10;
        if (intType !== 0x1) {
          throw new Error(`0x4: UNEXPECTED LENGTH-INT TYPE! ${intType}`);
        }
        const intInfo = int_type & 0x0f;
        const intLength = 2 ** intInfo;
        dataoffset = 2 + intLength;
        length = readUInt(
          buffer.subarray(currentOffset + 2, currentOffset + 2 + intLength),
        );
      }
      if (length >= MAX_OBJECT_SIZE) {
        throw new Error(
          `Too little heap space available! Wanted to read ${length} bytes, but only ${MAX_OBJECT_SIZE} are available.`,
        );
      }
      return buffer.subarray(
        currentOffset + dataoffset,
        currentOffset + dataoffset + length,
      );
    }

    function parsePlistString(isUtf16: boolean): string {
      let length = objInfo;
      let stroffset = 1;
      if (objInfo === 0xf) {
        const int_type = buffer[currentOffset + 1];
        if (int_type === undefined) {
          throw new Error("Missing integer type byte");
        }
        const intType = (int_type & 0xf0) / 0x10;
        if (intType !== 0x1) {
          throw new Error(`UNEXPECTED LENGTH-INT TYPE! ${intType}`);
        }
        const intInfo = int_type & 0x0f;
        const intLength = 2 ** intInfo;
        stroffset = 2 + intLength;
        length = readUInt(
          buffer.subarray(currentOffset + 2, currentOffset + 2 + intLength),
        );
      }
      // length is String length -> to get byte length multiply by 2
      // as 1 character takes 2 bytes in UTF-16
      length *= isUtf16 ? 2 : 1;
      if (length >= MAX_OBJECT_SIZE) {
        throw new Error(
          `Too little heap space available! Wanted to read ${length} bytes, but only ${MAX_OBJECT_SIZE} are available.`,
        );
      }
      const slice = buffer.subarray(
        currentOffset + stroffset,
        currentOffset + stroffset + length,
      );
      const plistString = Buffer.from(slice);
      let enc: BufferEncoding = "utf8";
      if (isUtf16) {
        swapBytes(plistString);
        enc = "ucs2";
      }
      return plistString.toString(enc);
    }

    function parseArray(): unknown[] {
      let length = objInfo;
      let arrayoffset = 1;
      if (objInfo === 0xf) {
        const int_type = buffer[currentOffset + 1];
        if (int_type === undefined) {
          throw new Error("Missing integer type byte");
        }
        const intType = (int_type & 0xf0) / 0x10;
        if (intType !== 0x1) {
          throw new Error(`0xa: UNEXPECTED LENGTH-INT TYPE! ${intType}`);
        }
        const intInfo = int_type & 0x0f;
        const intLength = 2 ** intInfo;
        arrayoffset = 2 + intLength;
        length = readUInt(
          buffer.subarray(currentOffset + 2, currentOffset + 2 + intLength),
        );
      }
      if (length * objectRefSize > MAX_OBJECT_SIZE) {
        throw new Error("Too little heap space available!");
      }
      const array: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const objRef = readUInt(
          buffer.subarray(
            currentOffset + arrayoffset + i * objectRefSize,
            currentOffset + arrayoffset + (i + 1) * objectRefSize,
          ),
        );
        array[i] = parseObject(objRef);
      }
      return array;
    }

    function parseDictionary(): Record<string, unknown> {
      let length = objInfo;
      let dictoffset = 1;
      if (objInfo === 0xf) {
        const int_type = buffer[currentOffset + 1];
        if (int_type === undefined) {
          throw new Error("Missing integer type byte");
        }
        const intType = (int_type & 0xf0) / 0x10;
        if (intType !== 0x1) {
          throw new Error(`0xD: UNEXPECTED LENGTH-INT TYPE! ${intType}`);
        }
        const intInfo = int_type & 0x0f;
        const intLength = 2 ** intInfo;
        dictoffset = 2 + intLength;
        length = readUInt(
          buffer.subarray(currentOffset + 2, currentOffset + 2 + intLength),
        );
      }
      if (length * 2 * objectRefSize > MAX_OBJECT_SIZE) {
        throw new Error("Too little heap space available!");
      }
      const dict: Record<string, unknown> = {};
      for (let i = 0; i < length; i++) {
        const keyRef = readUInt(
          buffer.subarray(
            currentOffset + dictoffset + i * objectRefSize,
            currentOffset + dictoffset + (i + 1) * objectRefSize,
          ),
        );
        const valRef = readUInt(
          buffer.subarray(
            currentOffset +
              dictoffset +
              length * objectRefSize +
              i * objectRefSize,
            currentOffset +
              dictoffset +
              length * objectRefSize +
              (i + 1) * objectRefSize,
          ),
        );
        const key = parseObject(keyRef);
        const val = parseObject(valRef);
        if (typeof key !== "string") {
          throw new Error(`Dictionary key must be a string, got ${typeof key}`);
        }
        dict[key] = val;
      }
      return dict;
    }
  }

  return [parseObject(topObject)];
}

function readUInt(buf: Buffer, start = 0): number {
  let l = 0;
  for (let i = start; i < buf.length; i++) {
    const byte = buf[i];
    if (byte !== undefined) {
      l <<= 8;
      l |= byte & 0xff;
    }
  }
  return l;
}

// We're just going to toss the high order bits because
// javascript doesn't have 64-bit ints
function readUInt64BE(buf: Buffer, start: number): number {
  const data = buf.subarray(start, start + 8);
  return data.readUInt32BE(4);
}

function swapBytes(buf: Buffer): void {
  const len = buf.length;
  for (let i = 0; i < len; i += 2) {
    const a = buf[i];
    const b = buf[i + 1];
    if (a !== undefined && b !== undefined) {
      buf[i] = b;
      buf[i + 1] = a;
    }
  }
}

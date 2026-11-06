// @ts-check

import { deflateSync } from "node:zlib";

/*
 * A QR code encoder, byte mode at error correction level M, and a PNG writer
 * for it. The actions run their sources with no dependencies, so this follows
 * Project Nayuki's QR Code generator (MIT License, Copyright (c) Project
 * Nayuki, https://www.nayuki.io/page/qr-code-generator-library), which the
 * Console's `uqr` ports too; the specs hold the two to the same modules.
 */

/** Error correction codewords per block at level M, by version. */
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
  26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28,
];

/** Error correction blocks at level M, by version. */
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
  18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** Level M's two format bits. */
const ECC_FORMAT_BITS = 0;

/** @param {number} version */
const rawDataModules = (version) => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};

/** @param {number} version */
const dataCodewords = (version) =>
  Math.floor(rawDataModules(version) / 8) -
  ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version];

/**
 * @param {number} x
 * @param {number} y
 */
const gfMultiply = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};

/** @param {number} degree */
const reedSolomonDivisor = (degree) => {
  /** @type {number[]} */
  const result = Array.from({ length: degree }, (_, i) =>
    i === degree - 1 ? 1 : 0,
  );
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
};

/**
 * @param {number[]} data
 * @param {number[]} divisor
 */
const reedSolomonRemainder = (data, divisor) => {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ /** @type {number} */ (result.shift());
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
};

/**
 * The data codewords split into blocks, each with its error correction, then
 * interleaved.
 * @param {number[]} data
 * @param {number} version
 */
const addErrorCorrection = (data, version) => {
  const blocks = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = reedSolomonDivisor(eccLength);
  /** @type {number[][]} */
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(
      k,
      k + shortLength - eccLength + (i < shortBlocks ? 0 : 1),
    );
    k += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    all.push([...block, ...ecc]);
  }
  /** @type {number[]} */
  const result = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) {
        result.push(block[i]);
      }
    });
  }
  return result;
};

/**
 * The QR code of `text`'s UTF-8 bytes at error correction level M, in the
 * smallest version that holds it, with the mask of the lowest penalty: the
 * same text always gives the same modules.
 *
 * @param {string} text
 * @returns {{ size: number, modules: boolean[][] }} `modules[y][x]`, true for
 *   dark, without a quiet zone.
 */
export const encodeQrCode = (text) => {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = 1;
  for (; ; version++) {
    if (version > 40) throw new Error("The text is too long for a QR code.");
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  const capacity = dataCodewords(version) * 8;
  /** @type {number[]} */
  const bits = [];
  /**
   * @param {number} value
   * @param {number} length
   */
  const append = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0x4, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    append(pad, 8);
  }
  /** @type {number[]} */
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit));
  }

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const isFunction = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  /**
   * @param {number} x
   * @param {number} y
   * @param {boolean} dark
   */
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing patterns, finder patterns, and alignment patterns.
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }
  /** @type {number[]} */
  const alignments = [];
  if (version > 1) {
    const count = Math.floor(version / 7) + 2;
    const step =
      Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    alignments.push(6);
    for (let position = size - 7; alignments.length < count; position -= step) {
      alignments.splice(1, 0, position);
    }
  }
  const last = alignments.length - 1;
  alignments.forEach((cx, i) =>
    alignments.forEach((cy, j) => {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      ) {
        return;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(
            cx + dx,
            cy + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }),
  );

  /** @param {number} mask */
  const drawFormatBits = (mask) => {
    const value = (ECC_FORMAT_BITS << 3) | mask;
    let remainder = value;
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const format = ((value << 10) | remainder) ^ 0x5412;
    /** @param {number} i */
    const bit = (i) => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
    setFunction(8, 7, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
    setFunction(8, size - 8, true);
  };
  // Reserves the format modules before the codewords are placed.
  drawFormatBits(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  const codewords = addErrorCorrection(data, version);
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  /** @param {number} mask */
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const invert = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask];
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
  };

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const score = penalty(modules);
    if (score < bestPenalty) {
      bestMask = mask;
      bestPenalty = score;
    }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);
  return { size, modules };
};

/**
 * The standard penalty of a masked symbol: runs, 2×2 blocks, finder-like
 * patterns, and the dark/light balance.
 * @param {boolean[][]} modules
 */
const penalty = (modules) => {
  const size = modules.length;
  let result = 0;
  /**
   * @param {number} length
   * @param {number[]} history
   */
  const addHistory = (length, history) => {
    if (history[0] === 0) length += size;
    history.pop();
    history.unshift(length);
  };
  /** @param {number[]} history */
  const countPatterns = (history) => {
    const n = history[1];
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  };
  /** @param {(i: number, j: number) => boolean} at */
  const lines = (at) => {
    for (let i = 0; i < size; i++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let j = 0; j < size; j++) {
        if (at(i, j) === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * 40;
          color = at(i, j);
          run = 1;
        }
      }
      if (color) {
        addHistory(run, history);
        run = 0;
      }
      run += size;
      addHistory(run, history);
      result += countPatterns(history) * 40;
    }
  };
  lines((y, x) => modules[y][x]);
  lines((x, y) => modules[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (
        y < size - 1 &&
        x < size - 1 &&
        modules[y][x] === modules[y][x + 1] &&
        modules[y][x] === modules[y + 1][x] &&
        modules[y][x] === modules[y + 1][x + 1]
      ) {
        result += 3;
      }
    }
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} bytes */
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * @param {string} type
 * @param {Buffer} data
 */
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/**
 * `text`'s QR code as a black-and-white PNG: `scale` pixels a module, with the
 * standard 4-module quiet zone. The same text always gives the same bytes.
 *
 * @param {string} text
 * @param {{ scale?: number }} [options]
 */
export const qrCodePng = (text, { scale = 6 } = {}) => {
  const { size, modules } = encodeQrCode(text);
  const border = 4;
  const pixels = (size + border * 2) * scale;
  const stride = Math.ceil(pixels / 8);
  const raw = Buffer.alloc((stride + 1) * pixels);
  for (let y = 0; y < pixels; y++) {
    const row = y * (stride + 1);
    // Filter type 0, then 1 bit a pixel: 1 is white in grayscale.
    for (let x = 0; x < pixels; x++) {
      const mx = Math.floor(x / scale) - border;
      const my = Math.floor(y / scale) - border;
      const dark =
        mx >= 0 && my >= 0 && mx < size && my < size && modules[my][mx];
      if (!dark) raw[row + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels, 0);
  header.writeUInt32BE(pixels, 4);
  header.set([1, 0, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

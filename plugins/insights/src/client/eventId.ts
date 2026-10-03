type RandomValuesSource = {
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
};

const formatUUIDv7 = (bytes: Uint8Array, timestamp: number): string => {
  // Division, not bit shifts: shifts truncate to 32 bits, and a millisecond
  // timestamp already needs 41.
  let time = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Creates an RFC 9562 UUIDv7: a 48-bit millisecond timestamp, then random bits.
 *
 * `createUUIDv7` from `@hot-updater/plugin-core` calls `crypto.getRandomValues`
 * unconditionally, but React Native has no Web Crypto unless the app installs a
 * polyfill. An Insights event ID only has to tell one event from another so a
 * retried POST is counted once, so `Math.random` is enough without one.
 */
export const createUUIDv7 = (): string => {
  const bytes = new Uint8Array(16);
  const { crypto } = globalThis as { crypto?: RandomValuesSource };
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return formatUUIDv7(bytes, Date.now());
};

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const encodeUtf8 = (value: string): number[] => {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
};

/** SHA-256 of a string's UTF-8 bytes, since React Native has no Web Crypto. */
export const sha256 = (value: string): Uint8Array => {
  const bytes = encodeUtf8(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) {
    // The length's high word, as division, since shifts truncate to 32 bits.
    bytes.push(
      shift >= 32
        ? Math.floor(bitLength / 2 ** shift) & 0xff
        : (bitLength >>> shift) & 0xff,
    );
  }

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const words: number[] = Array.from({ length: 64 }, () => 0);
  const rotate = (word: number, bits: number) =>
    (word >>> bits) | (word << (32 - bits));

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        (bytes[at]! << 24) |
        (bytes[at + 1]! << 16) |
        (bytes[at + 2]! << 8) |
        bytes[at + 3]!;
    }
    for (let index = 16; index < 64; index += 1) {
      const low = words[index - 15]!;
      const high = words[index - 2]!;
      const s0 = rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3);
      const s1 = rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index]! + words[index]!) | 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    const results = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      hash[index] = (hash[index]! + results[index]!) | 0;
    }
  }

  const digest = new Uint8Array(32);
  hash.forEach((word, index) => {
    digest[index * 4] = (word >>> 24) & 0xff;
    digest[index * 4 + 1] = (word >>> 16) & 0xff;
    digest[index * 4 + 2] = (word >>> 8) & 0xff;
    digest[index * 4 + 3] = word & 0xff;
  });
  return digest;
};

/**
 * A UUIDv7 derived from a key: its time field is `timestamp` and its random
 * bits are the key's SHA-256, so the same key and time always give the same
 * id, and a server that stores reports by id counts it once.
 */
export const createKeyedUUIDv7 = (key: string, timestamp: number): string =>
  formatUUIDv7(sha256(key).slice(0, 16), timestamp);

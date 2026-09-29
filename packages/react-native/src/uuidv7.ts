type RandomValuesSource = {
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
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

  // Division, not bit shifts: shifts truncate to 32 bits, and a millisecond
  // timestamp already needs 41.
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

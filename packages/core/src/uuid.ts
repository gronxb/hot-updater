export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const parseUuidBytes = (uuid: string): number[] => {
  const hex = uuid.replace(/-/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
};

const formatUuid = (bytes: number[]): string => {
  const out = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    out.slice(0, 8),
    out.slice(8, 12),
    out.slice(12, 16),
    out.slice(16, 20),
    out.slice(20),
  ].join("-");
};

/**
 * Masks a UUIDv7 by zeroing out all random bits (rand_a and rand_b),
 * keeping only the 48-bit timestamp, 4-bit version (7), and 2-bit variant (10).
 *
 * This produces the minimum valid UUIDv7 for a given timestamp,
 * making copy-promoted bundles (same timestamp, different random bits)
 * compare as equal.
 */
export const maskUuidV7Rand = (uuid: string): string => {
  const bytes = parseUuidBytes(uuid);

  // UUIDv7 layout:
  // bytes[0..5]  = 48-bit Unix timestamp in milliseconds
  // byte[6]      = version (high 4 bits) | rand_a (low 4 bits)
  // byte[7]      = rand_a (8 bits)
  // byte[8]      = variant (high 2 bits) | rand_b (low 6 bits)
  // bytes[9..15] = rand_b (56 bits)
  bytes[6] &= 0xf0; // keep version, clear rand_a high bits
  bytes[7] = 0x00; // clear rand_a low bits
  bytes[8] &= 0xc0; // keep variant, clear rand_b high bits
  for (let i = 9; i < 16; i++) {
    bytes[i] = 0x00; // clear rand_b remaining bits
  }

  return formatUuid(bytes);
};

/**
 * Masks a UUIDv7 by setting all random bits to their maximum values,
 * keeping only the 48-bit timestamp, 4-bit version (7), and 2-bit variant (10).
 *
 * This produces the maximum valid UUIDv7 for a given timestamp.
 * Used together with maskUuidV7Rand (lower bound) for range-based
 * equality checks: `id BETWEEN lower AND upper` means "same timestamp".
 */
export const maskUuidV7RandUpper = (uuid: string): string => {
  const bytes = parseUuidBytes(uuid);

  bytes[6] |= 0x0f; // keep version, set rand_a high bits to max
  bytes[7] = 0xff; // set rand_a low bits to max
  bytes[8] |= 0x3f; // keep variant, set rand_b high bits to max
  for (let i = 9; i < 16; i++) {
    bytes[i] = 0xff; // set rand_b remaining bits to max
  }

  return formatUuid(bytes);
};

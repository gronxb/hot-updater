export const extractTimestampFromUUIDv7 = (uuid: string) => {
  const timestampHex = uuid.split("-").join("").slice(0, 12);

  const timestamp = Number.parseInt(timestampHex, 16);

  return timestamp;
};

export const createUUIDv7WithSameTimestamp = (originalUuid: string) => {
  // Extract timestamp (first 48 bits / 12 hex chars) from original UUID
  const cleanUuid = originalUuid.split("-").join("");
  const timestampHex = cleanUuid.slice(0, 12);

  // Generate new random data for rand_a (12 bits) and rand_b (62 bits)
  const randomBytes = new Uint8Array(10); // Need 74 bits total (12 + 62), use 10 bytes
  crypto.getRandomValues(randomBytes);

  // Convert to hex
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // UUIDv7 structure according to IETF draft:
  // unix_ts_ms (48 bits) + ver (4 bits) + rand_a (12 bits) + var (2 bits) + rand_b (62 bits)

  // rand_a: 12 bits (3 hex chars)
  const randA = randomHex.slice(0, 3);

  // rand_b: 62 bits (15.5 hex chars, but we'll use 16 and mask properly)
  const randBHex = randomHex.slice(3, 19);

  // Version field (4 bits): 7
  const versionAndRandA = `7${randA}`; // 7xxx

  // Variant field (2 bits): "10" + rand_b (62 bits)
  // First byte of rand_b needs variant bits: 10xxxxxx
  const firstRandBByte = parseInt(randBHex.slice(0, 2), 16);
  const variantAndFirstRandB = (0x80 | (firstRandBByte & 0x3f))
    .toString(16)
    .padStart(2, "0");

  // Construct new UUID: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
  const newUuid = [
    timestampHex.slice(0, 8), // First 32 bits of timestamp
    timestampHex.slice(8, 12), // Last 16 bits of timestamp
    versionAndRandA, // Version (4 bits) + rand_a (12 bits)
    variantAndFirstRandB + randBHex.slice(2, 4), // Variant (2 bits) + first 14 bits of rand_b
    randBHex.slice(4, 16), // Last 48 bits of rand_b
  ].join("-");

  return newUuid;
};

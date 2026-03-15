export const extractTimestampFromUUIDv7 = (uuid: string) => {
  const timestampHex = uuid.split("-").join("").slice(0, 12);

  const timestamp = Number.parseInt(timestampHex, 16);

  return timestamp;
};

export const createUUIDv7WithSameTimestamp = (originalUuid: string) => {
  const cleanUuid = originalUuid.split("-").join("").toLowerCase();

  if (cleanUuid.length !== 32 || cleanUuid[12] !== "7") {
    throw new Error(`Invalid UUIDv7: ${originalUuid}`);
  }

  const maxTimestamp = (1n << 48n) - 1n;
  const maxSuffix = (1n << 74n) - 1n;
  const randBMask = (1n << 62n) - 1n;
  const randBRemainingMask = (1n << 60n) - 1n;

  let timestamp = BigInt(`0x${cleanUuid.slice(0, 12)}`);
  const randA = BigInt(`0x${cleanUuid.slice(13, 16)}`);
  const variantNibble = BigInt(`0x${cleanUuid.slice(16, 17)}`);
  const randB =
    ((variantNibble & 0x3n) << 60n) | BigInt(`0x${cleanUuid.slice(17)}`);

  // Keep the same timestamp when possible, but make the suffix monotonic
  // so the copied bundle always sorts after the original bundle ID.
  let suffix = (randA << 62n) | randB;
  if (suffix === maxSuffix) {
    if (timestamp === maxTimestamp) {
      throw new Error("Cannot create a newer UUIDv7: timestamp overflow");
    }
    timestamp += 1n;
    suffix = 0n;
  } else {
    suffix += 1n;
  }

  const nextRandA = suffix >> 62n;
  const nextRandB = suffix & randBMask;
  const variantHex = (0x8n | (nextRandB >> 60n)).toString(16);

  const nextUuidHex = [
    timestamp.toString(16).padStart(12, "0"),
    `7${nextRandA.toString(16).padStart(3, "0")}`,
    `${variantHex}${(nextRandB & randBRemainingMask)
      .toString(16)
      .padStart(15, "0")}`,
  ].join("");

  return [
    nextUuidHex.slice(0, 8),
    nextUuidHex.slice(8, 12),
    nextUuidHex.slice(12, 16),
    nextUuidHex.slice(16, 20),
    nextUuidHex.slice(20, 32),
  ].join("-");
};

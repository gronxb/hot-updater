export const generateMinBundleId = (): string => {
  const timestamp = BigInt(Date.now());
  // UUIDv7: 48-bit timestamp in milliseconds since epoch
  const timeHigh = Number((timestamp >> 16n) & 0xffffffffn);
  const timeLow = Number(timestamp & 0xffffn);
  // 4-bit version (0111 for version 7)
  const version = 0x7;
  // 2-bit variant (10xx)
  const variantBits = 0b10;
  // Random bits zero
  const randomA = 0;
  const randomB = 0;
  // Build each component
  const timeHighStr = timeHigh.toString(16).padStart(8, "0");
  const timeLowStr = timeLow.toString(16).padStart(4, "0");
  // For version field: high nibble is version, low 12 bits random (here zero)
  const versionAndRandomStr = ((version << 12) | (randomA & 0x0fff))
    .toString(16)
    .padStart(4, "0");
  // For variant field: 2 bits variant + 14 bits random (here zero)
  const variantAndRandomStr = ((variantBits << 14) | (randomB & 0x3fff))
    .toString(16)
    .padStart(4, "0");
  // Last 3 bytes (all zeros here)
  const nodeStr = "000000000000";
  // Compose UUID string
  return (
    `${timeHighStr}-${timeLowStr}-${versionAndRandomStr}-` +
    `${variantAndRandomStr}-${nodeStr}`
  );
};

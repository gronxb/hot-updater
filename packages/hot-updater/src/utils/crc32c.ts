/** The CRC32C (Castagnoli) checksum Google Cloud APIs verify payloads with. */
export const crc32c = (value: Uint8Array | string): number => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

import { describe, expect, it } from "vitest";

import { crc32c } from "./crc32c";

describe("crc32c", () => {
  it("matches the CRC-32C check value", () => {
    // RFC 3720 B.4's check value for "123456789".
    expect(crc32c("123456789")).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
    expect(crc32c("")).toBe(0);
  });
});

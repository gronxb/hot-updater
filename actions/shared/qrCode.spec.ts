import { inflateSync } from "node:zlib";

import jsQR from "jsqr";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";

import { encodeQrCode, qrCodePng } from "./qrCode.mjs";

/**
 * The pixels of a PNG `qrCodePng` writes: 1-bit grayscale, no interlace,
 * filter 0 on every row. Anything else fails the spec.
 */
const readPng = (png: Buffer) => {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // Bit depth 1, grayscale, deflate, filter method 0, no interlace.
      expect([...data.subarray(8)]).toEqual([1, 0, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(width / 8);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    for (let x = 0; x < width; x++) {
      const byte = raw[y * (stride + 1) + 1 + (x >> 3)]!;
      const value = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
      rgba.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
};

const LINKS = [
  "hu-sandbox-com-example-app://hot-updater/preview?channel=pr-12&fingerprint=8681de8b88a8db15b82606b4c0b5e5a1d1c0a0d2",
  "https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b001/download",
  "https://console.example.com/native-builds/019a0000-0000-7000-8000-00000000b001",
  "a",
  "https://example.com/" + "pr-12/".repeat(40),
  "https://example.com/?q=" + "é한".repeat(120),
];

describe("encodeQrCode", () => {
  it.each(LINKS)(
    "draws the modules the Console's library draws: %s",
    (text) => {
      const { data } = encode(text, { ecc: "M", border: 0 });
      expect(encodeQrCode(text).modules).toEqual(data);
    },
  );
});

describe("qrCodePng", () => {
  it.each(LINKS)("decodes back to its text: %s", (text) => {
    const { width, height, rgba } = readPng(qrCodePng(text));
    expect(width).toBe(height);
    expect(jsQR(rgba, width, height)?.data).toBe(text);
  });

  it("draws 6 pixels a module with a 4-module quiet zone", () => {
    const { size } = encodeQrCode(LINKS[0]!);
    expect(readPng(qrCodePng(LINKS[0]!)).width).toBe((size + 8) * 6);
  });

  it("writes the same bytes for the same text", () => {
    expect(qrCodePng(LINKS[0]!).equals(qrCodePng(LINKS[0]!))).toBe(true);
  });
});

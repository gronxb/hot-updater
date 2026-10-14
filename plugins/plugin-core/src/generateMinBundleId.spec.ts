import { describe, expect, it } from "vitest";

import { generateMinBundleId } from "./generateMinBundleId";
import { createUUIDv7After, extractTimestampFromUUIDv7 } from "./uuidv7";

describe("generateMinBundleId", () => {
  it("should generate a string", () => {
    expect(typeof generateMinBundleId()).toBe("string");
  });

  it("should generate a valid UUIDv7 format", () => {
    const id = generateMinBundleId();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(uuidRegex);
  });

  it("should have correct version (7)", () => {
    const id = generateMinBundleId();
    const parts = id.split("-");
    expect(parts[2].charAt(0)).toBe("7");
  });

  it("should have correct variant (8, 9, A, or B)", () => {
    const id = generateMinBundleId();
    const parts = id.split("-");
    const variantChar = parts[3].charAt(0);
    expect(["8", "9", "a", "b"].includes(variantChar)).toBe(true);
  });

  it("should embed a timestamp close to the current time", () => {
    const startTime = BigInt(Date.now());
    const id = generateMinBundleId();
    const endTime = BigInt(Date.now());

    const parts = id.split("-");
    const timeHigh = BigInt(`0x${parts[0]}`);
    const timeLow = BigInt(`0x${parts[1]}`);
    const timestamp = (timeHigh << 16n) | timeLow;

    expect(timestamp).toBeGreaterThanOrEqual(startTime);
    expect(timestamp).toBeLessThanOrEqual(endTime);
  });

  it("sorts after the bundle IDs issued before its millisecond and not after the ones issued from it", () => {
    const id = generateMinBundleId();
    const timestamp = extractTimestampFromUUIDv7(id);

    for (let i = 0; i < 100; i++) {
      expect(createUUIDv7After(null, timestamp - 1) < id).toBe(true);
      expect(createUUIDv7After(null, timestamp) >= id).toBe(true);
    }
  });
});

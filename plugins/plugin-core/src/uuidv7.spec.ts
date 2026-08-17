import { describe, expect, it } from "vitest";

import {
  createUUIDv7,
  createUUIDv7After,
  extractTimestampFromUUIDv7,
  isUUIDv7,
} from "./uuidv7";

describe("UUIDv7", () => {
  it("accepts generated canonical IDs and preserves lexical time order", () => {
    const first = createUUIDv7After(null, 1_000);
    const second = createUUIDv7After(first, 1_000);

    expect(isUUIDv7(createUUIDv7())).toBe(true);
    expect(isUUIDv7(first)).toBe(true);
    expect(second > first).toBe(true);
    expect(extractTimestampFromUUIDv7(second)).toBe(1_001);
  });

  it.each([
    "release-1",
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-7000-0000-000000000001",
    "00000000-0000-7000-8000-00000000000A",
  ])("rejects non-canonical Release ID %s", (value) => {
    expect(isUUIDv7(value)).toBe(false);
    expect(() => extractTimestampFromUUIDv7(value)).toThrow(
      "Expected a canonical lowercase UUIDv7",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  createUUIDv7WithSameTimestamp,
  extractTimestampFromUUIDv7,
} from "./extract-timestamp-from-uuidv7";

describe("extractTimestampFromUUIDv7", () => {
  it("extracts the first 48 bits as a millisecond timestamp", () => {
    expect(
      extractTimestampFromUUIDv7("01234567-89ab-7000-8000-000000000000"),
    ).toBe(0x0123456789ab);
  });
});

describe("createUUIDv7WithSameTimestamp", () => {
  it("increments the copied bundle ID by one while keeping the timestamp", () => {
    const originalUuid = "01234567-89ab-7000-8000-000000000000";

    const copiedUuid = createUUIDv7WithSameTimestamp(originalUuid);

    expect(copiedUuid).toBe("01234567-89ab-7000-8000-000000000001");
    expect(copiedUuid > originalUuid).toBe(true);
    expect(extractTimestampFromUUIDv7(copiedUuid)).toBe(
      extractTimestampFromUUIDv7(originalUuid),
    );
  });

  it("carries into rand_a when rand_b overflows", () => {
    expect(
      createUUIDv7WithSameTimestamp("01234567-89ab-7000-bfff-ffffffffffff"),
    ).toBe("01234567-89ab-7001-8000-000000000000");
  });

  it("increments the timestamp when the suffix is exhausted", () => {
    const originalUuid = "01234567-89ab-7fff-bfff-ffffffffffff";

    const copiedUuid = createUUIDv7WithSameTimestamp(originalUuid);

    expect(copiedUuid).toBe("01234567-89ac-7000-8000-000000000000");
    expect(copiedUuid > originalUuid).toBe(true);
    expect(extractTimestampFromUUIDv7(copiedUuid)).toBe(
      extractTimestampFromUUIDv7(originalUuid) + 1,
    );
  });

  it("throws for invalid UUIDv7 input", () => {
    expect(() =>
      createUUIDv7WithSameTimestamp("01234567-89ab-4000-8000-000000000000"),
    ).toThrowError("Invalid UUIDv7: 01234567-89ab-4000-8000-000000000000");
  });

  it("throws when the timestamp cannot be incremented anymore", () => {
    expect(() =>
      createUUIDv7WithSameTimestamp("ffffffff-ffff-7fff-bfff-ffffffffffff"),
    ).toThrowError("Cannot create a newer UUIDv7: timestamp overflow");
  });
});

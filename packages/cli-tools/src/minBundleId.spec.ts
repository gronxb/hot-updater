import {
  createUUIDv7After,
  extractTimestampFromUUIDv7,
  generateMinBundleId,
} from "@hot-updater/plugin-core";
import { isUUIDv7 } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import { createMinBundleId } from "./minBundleId";

describe("createMinBundleId", () => {
  it("is a UUIDv7 of the build's millisecond", () => {
    const before = Date.now();
    const id = createMinBundleId();
    const after = Date.now();

    expect(isUUIDv7(id)).toBe(true);
    expect(extractTimestampFromUUIDv7(id)).toBeGreaterThanOrEqual(before);
    expect(extractTimestampFromUUIDv7(id)).toBeLessThanOrEqual(after);
  });

  it("has all-zero random bits, as the podspec script phase and the Gradle task generate it", () => {
    expect(createMinBundleId(0x019a_0b1c_2d3e)).toBe(
      "019a0b1c-2d3e-7000-8000-000000000000",
    );
    expect(createMinBundleId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/,
    );
  });

  it("matches the min bundle ID plugin-core generates for the same millisecond", () => {
    const now = Date.now();
    const id = createMinBundleId(now);
    const generated = generateMinBundleId();

    expect(id.slice(14)).toBe(generated.slice(14));
    expect(extractTimestampFromUUIDv7(generated)).toBeGreaterThanOrEqual(now);
  });

  it("sorts after the bundles deployed before the build and before the ones deployed after it", () => {
    const timestamp = 1_700_000_000_000;
    const id = createMinBundleId(timestamp);
    for (let i = 0; i < 100; i++) {
      expect(createUUIDv7After(null, timestamp - 1) < id).toBe(true);
      expect(createUUIDv7After(null, timestamp + 1) > id).toBe(true);
    }
  });

  it("orders by the millisecond it is issued at", () => {
    expect(createMinBundleId(1_700_000_000_000)).toBe(
      createMinBundleId(1_700_000_000_000),
    );
    expect(
      createMinBundleId(1_700_000_000_001) >
        createMinBundleId(1_700_000_000_000),
    ).toBe(true);
  });
});

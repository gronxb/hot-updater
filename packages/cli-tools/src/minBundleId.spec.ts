import {
  createUUIDv7After,
  extractTimestampFromUUIDv7,
} from "@hot-updater/plugin-core";
import { isUUIDv7 } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import { createMinBundleId } from "./minBundleId";

describe("createMinBundleId", () => {
  it("is a UUIDv7 of the build's millisecond", () => {
    const before = Date.now();
    const id = createMinBundleId("ios");
    const after = Date.now();

    expect(isUUIDv7(id)).toBe(true);
    expect(extractTimestampFromUUIDv7(id)).toBeGreaterThanOrEqual(before);
    expect(extractTimestampFromUUIDv7(id)).toBeLessThanOrEqual(after);
  });

  it("passes the checks of the podspec script phase and the Gradle task", () => {
    for (const platform of ["ios", "android"] as const) {
      expect(createMinBundleId(platform)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("never collides across platforms, even in one millisecond", () => {
    const ios = new Set<string>();
    const android = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ios.add(createMinBundleId("ios", 1_700_000_000_000));
      android.add(createMinBundleId("android", 1_700_000_000_000));
    }

    for (const id of ios) {
      expect(android.has(id)).toBe(false);
    }
  });

  it("keeps two builds of one platform in one millisecond apart", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () =>
        createMinBundleId("android", 1_700_000_000_000),
      ),
    );

    expect(ids.size).toBe(100);
  });

  it("sorts after the bundles deployed before the build and before the ones deployed after it", () => {
    const timestamp = 1_700_000_000_000;
    for (const platform of ["ios", "android"] as const) {
      const id = createMinBundleId(platform, timestamp);
      for (let i = 0; i < 100; i++) {
        expect(createUUIDv7After(null, timestamp - 1) < id).toBe(true);
        expect(createUUIDv7After(null, timestamp + 1) > id).toBe(true);
      }
    }
  });
});

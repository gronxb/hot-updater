import { randomBytes } from "node:crypto";

import type { Platform } from "@hot-updater/protocol";

/** The first byte of a native build's MIN_BUNDLE_ID node, per platform. */
const PLATFORM_NODE_BYTE = {
  ios: 0x01,
  android: 0x02,
} as const satisfies Record<Platform, number>;

/**
 * The MIN_BUNDLE_ID a native build compiles in, which is also the ID of its
 * built-in bundle. It is a UUIDv7 of the build's millisecond with zero
 * `rand_a` bits, so the bundles `hot-updater deploy` issued before the build
 * sort before it and the ones it issues afterwards sort after it. Bundle IDs
 * share one space across platforms, so its node starts with a platform byte,
 * which keeps an iOS and an Android build from colliding, and ends with
 * random bytes, which keep two builds of one platform from colliding when
 * they start in the same millisecond.
 */
export const createMinBundleId = (
  platform: Platform,
  nowMs = Date.now(),
): string => {
  const timestamp = nowMs.toString(16).padStart(12, "0");
  const nodeHex =
    PLATFORM_NODE_BYTE[platform].toString(16).padStart(2, "0") +
    randomBytes(5).toString("hex");

  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${nodeHex}`;
};

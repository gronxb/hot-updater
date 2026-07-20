import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const iosInternalDirectory = resolve(
  import.meta.dirname,
  "../ios/HotUpdater/Internal",
);

const readIOSSource = (filename: string) =>
  readFileSync(resolve(iosInternalDirectory, filename), "utf8");

describe("iOS Objective-C interoperability", () => {
  it("does not call an autoreleased NSString through raw Swift ABI", () => {
    const bridgingHeader = readIOSSource("HotUpdater-Bridging-Header.h");
    const implementation = readIOSSource("HotUpdaterImpl.swift");

    expect(implementation).not.toContain(
      '@_silgen_name("HotUpdaterGetMinBundleId")',
    );
    expect(bridgingHeader).toContain("+ (NSString *)minBundleId;");
    expect(implementation).toContain(
      "HotUpdaterRecoverySignalBridge.minBundleId() as String",
    );
  });
});

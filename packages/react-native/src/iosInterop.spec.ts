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
    const implementation = readIOSSource("HotUpdaterImpl.swift");
    const objectiveCImplementation = readIOSSource("HotUpdater.mm");

    expect(implementation).not.toContain(
      '@_silgen_name("HotUpdaterGetMinBundleId")',
    );
    expect(implementation).toContain(
      '@_silgen_name("HotUpdaterCopyMinBundleId")',
    );
    expect(implementation).toContain(".takeRetainedValue() as String");
    expect(objectiveCImplementation).toContain(
      "return (__bridge_retained void *)HotUpdaterGetMinBundleId();",
    );
  });
});

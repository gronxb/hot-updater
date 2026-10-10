import { describe, expect, it } from "vitest";

import { appendFingerprintExtraSources } from "./common";
import { getFingerprintDiff } from "./diff";

describe("appendFingerprintExtraSources", () => {
  it("appends integration inputs without crossing platform-specific sources", () => {
    expect(
      appendFingerprintExtraSources(
        { ios: ["ios/private.xcconfig"], android: ["android/gradle.lockfile"] },
        ["native-profile.json"],
      ),
    ).toEqual({
      ios: ["ios/private.xcconfig", "native-profile.json"],
      android: ["android/gradle.lockfile", "native-profile.json"],
    });
  });

  it("deduplicates shared integration inputs", () => {
    expect(
      appendFingerprintExtraSources(
        ["native-profile.json"],
        ["native-profile.json"],
      ),
    ).toEqual(["native-profile.json"]);
  });
});

describe("getFingerprintDiff", () => {
  it("compares provider-neutral source identities and hashes", () => {
    const before = {
      hash: "before",
      sources: [
        {
          type: "file" as const,
          filePath: "ios/Podfile.lock",
          reasons: ["native"],
          hash: "a",
        },
      ],
    };
    const after = {
      hash: "after",
      sources: [
        {
          type: "file" as const,
          filePath: "ios/Podfile.lock",
          reasons: ["native"],
          hash: "b",
        },
      ],
    };
    expect(getFingerprintDiff(before, after)).toEqual([
      {
        op: "changed",
        beforeSource: before.sources[0],
        afterSource: after.sources[0],
      },
    ]);
  });
});

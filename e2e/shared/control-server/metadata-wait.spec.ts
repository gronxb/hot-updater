import { describe, expect, it } from "vitest";

import {
  isExpectedMetadataStateReached,
  resolveMetadataWaitReleaseId,
} from "./metadata-wait.ts";

const bundleId = "00000000-0000-7000-8000-000000000000";
const deployments = [
  { bundleId, releaseId: "server-A" },
  { bundleId, releaseId: "republished-A" },
];
const recovered = {
  stableBundleId: bundleId,
  stagingBundleId: bundleId,
  stagingSelection: { releaseId: null },
  verificationPending: false,
};

describe("metadata wait selection", () => {
  it("preserves explicit builtin recovery after a server Release of the same Bundle fails", () => {
    const releaseId = resolveMetadataWaitReleaseId(bundleId, null, deployments);
    expect(releaseId).toBeNull();
    expect(
      isExpectedMetadataStateReached(
        recovered,
        bundleId,
        false,
        releaseId,
        true,
      ),
    ).toBe(true);
    expect(
      isExpectedMetadataStateReached(
        { ...recovered, stagingSelection: { releaseId: "server-A" } },
        bundleId,
        false,
        releaseId,
        true,
      ),
    ).toBe(false);
  });

  it("infers only omitted Release IDs and retains an explicitly selected republished Release", () => {
    expect(resolveMetadataWaitReleaseId(bundleId, undefined, deployments)).toBe(
      "republished-A",
    );
    expect(
      resolveMetadataWaitReleaseId(bundleId, "server-A", deployments),
    ).toBe("server-A");
    expect(
      isExpectedMetadataStateReached(
        recovered,
        bundleId,
        false,
        "server-A",
        true,
      ),
    ).toBe(false);
  });

  it("requires the Lynx pending state while retaining the RN confirmation race policy", () => {
    expect(
      isExpectedMetadataStateReached(recovered, bundleId, true, null, true),
    ).toBe(false);
    expect(
      isExpectedMetadataStateReached(recovered, bundleId, true, null, false),
    ).toBe(true);
    expect(
      isExpectedMetadataStateReached(
        recovered,
        "another-bundle",
        false,
        null,
        true,
      ),
    ).toBe(false);
  });
});

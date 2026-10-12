import { describe, expect, it } from "vitest";

import { hasNativeInstallEvent } from "./native-install-log";

describe("native install log evidence", () => {
  it.each([
    "HotUpdaterBsdiffPatchApplied bundleId=target baseBundleId=base asset=main.lynx.bundle",
    "2026-09-13 I HotUpdaterLynx: HotUpdaterBsdiffPatchApplied asset=main.lynx.bundle baseBundleId=base bundleId=target",
  ])("accepts one correlated event line: %s", (logs) => {
    expect(
      hasNativeInstallEvent(logs, "HotUpdaterBsdiffPatchApplied", {
        asset: "main.lynx.bundle",
        baseBundleId: "base",
        bundleId: "target",
      }),
    ).toBe(true);
  });

  it("rejects expected values assembled from unrelated lines", () => {
    expect(
      hasNativeInstallEvent(
        [
          "HotUpdaterBsdiffPatchApplied bundleId=other baseBundleId=base",
          "download asset=main.lynx.bundle bundleId=target",
        ].join("\n"),
        "HotUpdaterBsdiffPatchApplied",
        {
          asset: "main.lynx.bundle",
          baseBundleId: "base",
          bundleId: "target",
        },
      ),
    ).toBe(false);
  });

  it("distinguishes verified archive fallback from a warning", () => {
    expect(
      hasNativeInstallEvent(
        "Manifest-driven install failed bundleId=target baseBundleId=base",
        "HotUpdaterArchiveFallbackApplied",
        { baseBundleId: "base", bundleId: "target" },
      ),
    ).toBe(false);
    expect(
      hasNativeInstallEvent(
        "HotUpdaterArchiveFallbackApplied bundleId=target baseBundleId=base",
        "HotUpdaterArchiveFallbackApplied",
        { baseBundleId: "base", bundleId: "target" },
      ),
    ).toBe(true);
  });
});

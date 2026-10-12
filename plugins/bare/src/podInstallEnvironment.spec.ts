import { afterEach, expect, it, vi } from "vitest";

import { getReactNativePodInstallEnvironment } from "./podInstallEnvironment";

const metadata = vi.hoisted(() => vi.fn());
vi.mock("./reactNativeMetadata", () => ({ getReactNativeMetadatas: metadata }));
afterEach(() => {
  vi.unstubAllEnvs();
  metadata.mockReset();
});

it.each([
  [80, "0"],
  [81, "1"],
  [85, "1"],
])("keeps RN 0.%i CocoaPods defaults in the integration", (minor, prebuilt) => {
  vi.stubEnv("RCT_USE_RN_DEP", undefined);
  vi.stubEnv("RCT_USE_PREBUILT_RNCORE", undefined);
  metadata.mockReturnValue({ version: { minor } });
  expect(getReactNativePodInstallEnvironment("/project")).toEqual({
    RCT_IGNORE_PODS_DEPRECATION: "1",
    RCT_USE_RN_DEP: prebuilt,
    RCT_USE_PREBUILT_RNCORE: prebuilt,
  });
  expect(metadata).toHaveBeenCalledExactlyOnceWith("/project");
});

it("preserves explicit RN build overrides without mutating the parent process", () => {
  vi.stubEnv("RCT_USE_RN_DEP", "0");
  vi.stubEnv("RCT_USE_PREBUILT_RNCORE", "");
  vi.stubEnv("RCT_IGNORE_PODS_DEPRECATION", undefined);
  metadata.mockReturnValue({ version: { minor: 85 } });
  expect(getReactNativePodInstallEnvironment("/project")).toEqual({
    RCT_IGNORE_PODS_DEPRECATION: "1",
    RCT_USE_RN_DEP: "0",
    RCT_USE_PREBUILT_RNCORE: "",
  });
  expect(process.env["RCT_IGNORE_PODS_DEPRECATION"]).toBeUndefined();
});

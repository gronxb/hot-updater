import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canSdkVersion,
  canSdkVersionAtLeast,
  canSdkVersionSatisfy,
  getInjectedSdkVersion,
} from "./sdkVersionGuard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sdkVersionGuard", () => {
  it("reads the injected sdk version from the build env", () => {
    vi.stubEnv("VITE_HOT_UPDATER_SDK_VERSION", "0.29.0");

    expect(getInjectedSdkVersion()).toBe("0.29.0");
  });

  it("checks minimum sdk versions", () => {
    expect(canSdkVersionAtLeast("0.29.0", "0.29.0")).toBe(true);
    expect(canSdkVersionAtLeast("0.28.9", "0.29.0")).toBe(false);
  });

  it("supports reusable range guards", () => {
    expect(canSdkVersionSatisfy("^0.29.0", ">=0.29.0")).toBe(true);
    expect(canSdkVersionSatisfy(">=0.28.0", ">=0.29.0")).toBe(false);
  });

  it("checks the current injected sdk version", () => {
    vi.stubEnv("VITE_HOT_UPDATER_SDK_VERSION", "0.29.0");
    expect(canSdkVersion("0.29.0")).toBe(true);

    vi.stubEnv("VITE_HOT_UPDATER_SDK_VERSION", "0.28.0");
    expect(canSdkVersion("0.29.0")).toBe(false);
  });
});

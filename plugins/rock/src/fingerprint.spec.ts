import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReactNativeFingerprint: vi.fn(async () => ({
    hash: "rn-fingerprint",
    sources: [],
  })),
}));

vi.mock("@hot-updater/react-native/build", () => ({
  createReactNativeFingerprint: mocks.createReactNativeFingerprint,
  selectReactNativeArtifacts: vi.fn(),
}));

import { rock } from "./index";

describe("Rock native fingerprint", () => {
  it("uses the React Native provider with its default configuration", async () => {
    const plugin = rock()({ cwd: "/app" });
    const options = { platform: "android" as const };

    await expect(plugin.nativeBuild?.fingerprint?.(options)).resolves.toEqual({
      hash: "rn-fingerprint",
      sources: [],
    });
    expect(mocks.createReactNativeFingerprint).toHaveBeenCalledWith(
      "/app",
      options,
    );
  });
});

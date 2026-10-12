import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReactNativeFingerprint: vi.fn(async () => ({
    hash: "rn-fingerprint",
    sources: [],
  })),
}));

vi.mock("./buildFingerprint", () => ({
  createReactNativeFingerprint: mocks.createReactNativeFingerprint,
}));

import { bare } from "./bare";

describe("Bare native fingerprint", () => {
  it("uses the React Native provider with the default Hermes configuration", async () => {
    const plugin = bare({ enableHermes: true })({ cwd: "/app" });
    const options = { platform: "ios" as const };

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

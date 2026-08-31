// @vitest-environment node

import { describe, expect, it } from "vitest";

import { inspectBundleSigning } from "./bundle-signing.server";

describe("bundle signing inspection", () => {
  it("reports non-secret signing metadata without invoking a provider", async () => {
    await expect(
      inspectBundleSigning({
        enabled: true,
        provider: "Managed signing",
      }),
    ).resolves.toEqual({
      algorithm: "RSA-SHA256",
      provider: "Managed signing",
      status: "enabled",
    });
  });

  it("reports disabled signing", async () => {
    await expect(
      inspectBundleSigning({
        enabled: false,
      }),
    ).resolves.toEqual({ status: "disabled" });
  });
});

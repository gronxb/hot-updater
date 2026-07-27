import { describe, expect, it, vi } from "vitest";

import {
  CloudflareAuthenticationError,
  isCloudflareAuthenticationError,
  validateCloudflareApiToken,
} from "./cloudflareInitErrors";

describe("Cloudflare init authentication", () => {
  it.each([
    new Error("Authentication error [code: 10000]"),
    new Error("Invalid access token [code: 9109]"),
    new Error("Invalid format for Authorization header [code: 6111]"),
  ])("recognizes Cloudflare authentication failures", (error) => {
    expect(isCloudflareAuthenticationError(error)).toBe(true);
  });

  it("checks token status before account permission probes", async () => {
    // Given
    const probe = vi.fn();

    // When
    const validation = validateCloudflareApiToken({
      probes: [probe],
      source: { kind: "prompt" },
      verify: vi.fn().mockResolvedValue({ status: "expired" }),
    });

    // Then
    await expect(validation).rejects.toBeInstanceOf(
      CloudflareAuthenticationError,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("runs permission probes for an active token", async () => {
    // Given
    const probe = vi.fn().mockResolvedValue(undefined);

    // When
    await validateCloudflareApiToken({
      probes: [probe],
      source: { kind: "prompt" },
      verify: vi.fn().mockResolvedValue({ status: "active" }),
    });

    // Then
    expect(probe).toHaveBeenCalledOnce();
  });
});

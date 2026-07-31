import { describe, expect, it, vi } from "vitest";

import { validateCloudflareApiToken } from "./cloudflareApiToken";
import {
  CloudflareAuthenticationError,
  isCloudflareAuthenticationError,
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
      accountId: "account-id",
      probes: [
        {
          check: "D1 database access",
          request: probe,
          requiredPermission: "D1: Edit",
        },
      ],
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
      accountId: "account-id",
      probes: [
        {
          check: "D1 database access",
          request: probe,
          requiredPermission: "D1: Edit",
        },
      ],
      source: { kind: "prompt" },
      verify: vi.fn().mockResolvedValue({ status: "active" }),
    });

    // Then
    expect(probe).toHaveBeenCalledOnce();
  });

  it("identifies the failed account resource permission after token verification", async () => {
    // Given
    const probe = vi
      .fn()
      .mockRejectedValue(new Error("Authentication error [code: 10000]"));

    // When
    const validation = validateCloudflareApiToken({
      accountId: "account-id",
      probes: [
        {
          check: "R2 bucket access",
          request: probe,
          requiredPermission: "Workers R2 Storage: Edit",
        },
      ],
      source: { kind: "prompt" },
      verify: vi.fn().mockResolvedValue({ status: "active" }),
    });

    // Then
    await expect(validation).rejects.toMatchObject({
      accountId: "account-id",
      check: "R2 bucket access",
      name: "CloudflarePermissionError",
      requiredPermission: "Workers R2 Storage: Edit",
    });
  });
});

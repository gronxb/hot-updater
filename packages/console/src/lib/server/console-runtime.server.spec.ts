// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { sanitizeConsoleSigningConfig } from "./console-runtime.server";

describe("Console signing config sanitization", () => {
  it("keeps only the provider display name and public path", () => {
    const sign = vi.fn();
    const getPublicKey = vi.fn();
    const sanitized = sanitizeConsoleSigningConfig({
      getPublicKey,
      keyRef: "provider-secret-reference",
      privateKeyPath: "/secret/private-key.pem",
      name: "Managed signing",
      publicKeyPath: "keys/public-key.pem",
      sign,
    });

    expect(sanitized).toEqual({
      enabled: true,
      provider: "Managed signing",
      publicKeyPath: "keys/public-key.pem",
    });
    expect(sanitized).not.toHaveProperty("keyRef");
    expect(sanitized).not.toHaveProperty("privateKeyPath");
    expect(sanitized).not.toHaveProperty("sign");
    expect(sanitized).not.toHaveProperty("getPublicKey");
    expect(JSON.stringify(sanitized)).not.toContain(
      "provider-secret-reference",
    );
    expect(sign).not.toHaveBeenCalled();
    expect(getPublicKey).not.toHaveBeenCalled();
  });

  it("uses omission to represent disabled signing", () => {
    expect(sanitizeConsoleSigningConfig(undefined)).toBeUndefined();
  });
});

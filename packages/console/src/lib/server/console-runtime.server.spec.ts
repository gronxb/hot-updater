// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { sanitizeConsoleSigningConfig } from "./console-runtime.server";

describe("Console signing config sanitization", () => {
  it("derives only the checked-in public key beside the legacy private key", () => {
    expect(
      sanitizeConsoleSigningConfig({
        enabled: true,
        privateKeyPath: "secrets/signing/private-key.pem",
      }),
    ).toEqual({
      enabled: true,
      provider: "Local file",
      publicKeyPath: "secrets/signing/public-key.pem",
    });
  });

  it("does not derive a public path from an arbitrary private key filename", () => {
    expect(
      sanitizeConsoleSigningConfig({
        enabled: true,
        privateKeyPath: "secrets/production.pem",
      }),
    ).toEqual({ enabled: true, provider: "Local file" });
  });

  it("keeps only the provider display name and public path", () => {
    const sign = vi.fn();
    const sanitized = sanitizeConsoleSigningConfig({
      enabled: true,
      keyRef: "provider-secret-reference",
      privateKeyPath: "/secret/private-key.pem",
      provider: { name: "Managed signing", sign },
      publicKeyPath: "keys/public-key.pem",
    });

    expect(sanitized).toEqual({
      enabled: true,
      provider: "Managed signing",
      publicKeyPath: "keys/public-key.pem",
    });
    expect(sanitized).not.toHaveProperty("keyRef");
    expect(sanitized).not.toHaveProperty("privateKeyPath");
    expect(sanitized).not.toHaveProperty("sign");
    expect(JSON.stringify(sanitized)).not.toContain(
      "provider-secret-reference",
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it("reports disabled without retaining provider details", () => {
    expect(
      sanitizeConsoleSigningConfig({
        enabled: false,
        privateKeyPath: "/secret/private-key.pem",
        provider: { name: "Managed signing" },
      }),
    ).toEqual({ enabled: false });
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { sanitizeConsoleSigningConfig } from "./console-runtime.server";

describe("Console signing config sanitization", () => {
  it("keeps only the provider display name", () => {
    const sign = vi.fn();
    const getPublicKey = vi.fn();
    const sanitized = sanitizeConsoleSigningConfig({
      getPublicKey,
      keyRef: "provider-secret-reference",
      name: "Managed signing",
      sign,
    });

    expect(sanitized).toEqual({
      enabled: true,
      provider: "Managed signing",
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

  it("labels raw local config without exposing its private path", () => {
    const sanitized = sanitizeConsoleSigningConfig({
      enabled: true,
      privateKeyPath: "/secret/private-key-canary.pem",
    });

    expect(sanitized).toEqual({
      enabled: true,
      provider: "localSigning",
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-key-canary.pem");
  });

  it("uses omission to represent disabled signing", () => {
    expect(sanitizeConsoleSigningConfig(undefined)).toBeUndefined();
    expect(sanitizeConsoleSigningConfig({ enabled: false })).toBeUndefined();
    expect(
      sanitizeConsoleSigningConfig({
        enabled: false,
        privateKeyPath: "/secret/key.pem",
      }),
    ).toBeUndefined();
    expect(
      sanitizeConsoleSigningConfig({ privateKeyPath: "/secret/key.pem" }),
    ).toBeUndefined();
  });

  it("does not expose a local private key path", () => {
    const sanitized = sanitizeConsoleSigningConfig({
      enabled: true,
      privateKeyPath: "keys/private-canary.pem",
    });
    expect(sanitized).toEqual({
      enabled: true,
      provider: "localSigning",
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-canary");
  });
});

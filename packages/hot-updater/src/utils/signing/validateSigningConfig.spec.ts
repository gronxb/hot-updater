import crypto from "node:crypto";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const parser = vi.hoisted(() => ({
  android: {
    exists: vi.fn(),
    get: vi.fn(),
  },
  ios: {
    exists: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("../configParser/androidParser", () => ({
  AndroidConfigParser: vi.fn(function AndroidConfigParser() {
    return parser.android;
  }),
}));

vi.mock("../configParser/iosParser", () => ({
  IosConfigParser: vi.fn(function IosConfigParser() {
    return parser.ios;
  }),
}));

import { validateSigningConfig } from "./validateSigningConfig";

const createPublicKey = () =>
  crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();

const createConfig = (): ConfigResponse =>
  ({
    platform: {
      android: { androidManifestPaths: ["AndroidManifest.xml"] },
      ios: { infoPlistPaths: ["Info.plist"] },
    },
    signing: {
      getPublicKey: async () => ({ publicKey: "public-key" }),
      name: "test-signing",
      sign: async ({ message }) => ({ signature: message }),
    },
  }) as ConfigResponse;

describe("validateSigningConfig", () => {
  beforeEach(() => {
    parser.android.exists.mockResolvedValue(true);
    parser.ios.exists.mockResolvedValue(true);
  });

  it("rejects native public keys that do not match the signing session", async () => {
    const expectedPublicKey = createPublicKey();
    parser.android.get.mockResolvedValue({
      paths: ["AndroidManifest.xml"],
      value: createPublicKey(),
    });
    parser.ios.get.mockResolvedValue({
      paths: ["Info.plist"],
      value: createPublicKey(),
    });

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "PUBLIC_KEY_MISMATCH",
        platform: "ios",
      }),
      expect.objectContaining({
        code: "PUBLIC_KEY_MISMATCH",
        platform: "android",
      }),
    ]);
  });

  it("accepts canonical-equivalent public keys with escaped newlines", async () => {
    const expectedPublicKey = createPublicKey();
    parser.android.get.mockResolvedValue({
      paths: ["AndroidManifest.xml"],
      value: expectedPublicKey.trim().replaceAll("\n", "\\n"),
    });
    parser.ios.get.mockResolvedValue({
      paths: ["Info.plist"],
      value: expectedPublicKey,
    });

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a matching private PEM embedded as a native public key", async () => {
    const keyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    parser.android.get.mockResolvedValue({
      paths: ["AndroidManifest.xml"],
      value: keyPair.privateKey,
    });
    parser.ios.get.mockResolvedValue({
      paths: ["Info.plist"],
      value: keyPair.privateKey,
    });

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey: keyPair.publicKey,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "PUBLIC_KEY_MISMATCH",
      "PUBLIC_KEY_MISMATCH",
    ]);
  });

  it("rejects a matching RSA trust anchor weaker than 2048 bits", async () => {
    const weakPublicKey = crypto
      .generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    parser.android.get.mockResolvedValue({
      paths: ["AndroidManifest.xml"],
      value: weakPublicKey,
    });
    parser.ios.get.mockResolvedValue({
      paths: ["Info.plist"],
      value: weakPublicKey,
    });

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey: weakPublicKey,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "PUBLIC_KEY_MISMATCH",
      "PUBLIC_KEY_MISMATCH",
    ]);
  });

  it("validates an Expo CNG trust anchor when native files do not exist", async () => {
    const publicKey = createPublicKey();
    parser.android.exists.mockResolvedValue(false);
    parser.ios.exists.mockResolvedValue(false);

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey: publicKey,
      nativePublicKey: publicKey,
    });

    expect(result.isValid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.nativePublicKeys).toEqual({
      android: { exists: true, paths: ["Expo app config"] },
      ios: { exists: true, paths: ["Expo app config"] },
    });
  });

  it("rejects signed Expo CNG builds without a trust anchor", async () => {
    parser.android.exists.mockResolvedValue(false);
    parser.ios.exists.mockResolvedValue(false);

    const result = await validateSigningConfig(createConfig(), {
      expectedPublicKey: createPublicKey(),
      nativePublicKey: null,
    });

    expect(result.isValid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "MISSING_PUBLIC_KEY",
      "MISSING_PUBLIC_KEY",
    ]);
  });
});

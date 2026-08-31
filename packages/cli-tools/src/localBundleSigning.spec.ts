import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalSigningPlugin,
  normalizeSigningConfig,
} from "./localBundleSigning";

const tempDirs: string[] = [];

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-signing-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("normalizeSigningConfig", () => {
  it("keeps an explicit signing plugin unchanged", () => {
    const plugin = {
      name: "test-signer",
      getPublicKey: vi.fn(),
      sign: vi.fn(),
    } satisfies BundleSigningPlugin;

    expect(normalizeSigningConfig(plugin)).toBe(plugin);
    expect(plugin.getPublicKey).not.toHaveBeenCalled();
    expect(plugin.sign).not.toHaveBeenCalled();
  });

  it("keeps local config without reading keys during normalization", () => {
    const local = {
      enabled: true,
      privateKeyPath: "/missing/private-key.pem",
    } as const;
    expect(normalizeSigningConfig(local)).toEqual(local);
  });

  it("keeps disabled and omitted signing configurations inactive", () => {
    expect(normalizeSigningConfig(undefined)).toBeUndefined();
    expect(normalizeSigningConfig({ enabled: false })).toBeUndefined();
    expect(
      normalizeSigningConfig({
        enabled: false,
        privateKeyPath: "/missing/key.pem",
      }),
    ).toBeUndefined();
    expect(() =>
      normalizeSigningConfig({ privateKeyPath: "/missing/key.pem" } as never),
    ).toThrow("must be a local key config or signing plugin");
  });

  it("signs with the private key only on use", async () => {
    const cwd = await createTempDir();
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.mkdir(path.join(cwd, "keys"));
    await fs.writeFile(path.join(cwd, "keys/private-key.pem"), privateKey);

    const signing = createLocalSigningPlugin({
      enabled: true,
      privateKeyPath: "./keys/private-key.pem",
    });
    const message = crypto.randomBytes(32);

    expect(signing?.name).toBe("localSigning");
    expect(signing).not.toHaveProperty("privateKeyPath");
    const { publicKey } = await signing!.getPublicKey({ cwd });
    const { signature } = await signing!.sign({ cwd, message });
    expect(crypto.verify("RSA-SHA256", message, publicKey, signature)).toBe(
      true,
    );
  });

  it("rejects malformed and ambiguous local config", () => {
    expect(() =>
      normalizeSigningConfig({
        enabled: true,
        privateKeyPath: "./private-key.pem",
        publicKeyPath: "./public-key.pem",
      } as never),
    ).toThrow("accepts only enabled and privateKeyPath");
    expect(() =>
      normalizeSigningConfig({
        getPublicKey: vi.fn(),
        name: "ambiguous",
        privateKeyPath: "./private-key.pem",
        sign: vi.fn(),
      } as never),
    ).toThrow("cannot combine local signing fields");
    expect(() =>
      normalizeSigningConfig({
        enabled: true,
        privateKeyPath: "",
      } as never),
    ).toThrow("requires privateKeyPath");
  });

  it("redacts local private key read failures", async () => {
    const cwd = await createTempDir();
    const signing = createLocalSigningPlugin({
      enabled: true,
      privateKeyPath: "private-key-canary.pem",
    });

    await expect(signing?.getPublicKey({ cwd })).rejects.toThrow(
      "Failed to load the local bundle signing private key.",
    );
    await expect(signing?.getPublicKey({ cwd })).rejects.not.toThrow(
      "private-key-canary.pem",
    );
  });

  it("rejects weak keys and messages outside the signing contract", async () => {
    const cwd = await createTempDir();
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.writeFile(path.join(cwd, "private-key.pem"), privateKey);
    const signing = createLocalSigningPlugin({
      enabled: true,
      privateKeyPath: "private-key.pem",
    });

    await expect(signing?.getPublicKey({ cwd })).rejects.toThrow(
      "Failed to load the local bundle signing private key.",
    );
    await expect(
      signing?.sign({ cwd, message: new Uint8Array(31) }),
    ).rejects.toThrow("messages must be exactly 32 bytes");
  });
});

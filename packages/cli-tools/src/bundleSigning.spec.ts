import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareBundleSigning } from "./bundleSigning";

const tempDirs: string[] = [];

const createKeyPair = () =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-signing-"));
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

describe("prepareBundleSigning", () => {
  it("uses omission to disable signing and rejects the legacy shape", async () => {
    await expect(prepareBundleSigning(undefined)).resolves.toBeNull();
    await expect(
      prepareBundleSigning({ enabled: false } as never),
    ).rejects.toThrow(
      "Bundle signing must be configured with a signing plugin. Omit signing to disable it.",
    );
  });

  it("pins the provider public key and memoizes each file hash", async () => {
    const dir = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    await fs.writeFile(path.join(dir, "public.pem"), publicKey);
    const sign = vi.fn(async ({ message }: { message: Uint8Array }) => ({
      signature: crypto.sign("RSA-SHA256", message, privateKey),
    }));
    const provider = {
      name: "test-provider",
      publicKeyPath: "public.pem",
      getPublicKey: vi.fn(async () => ({ publicKey })),
      sign,
    } satisfies BundleSigningPlugin;
    const session = await prepareBundleSigning(provider, { cwd: dir });
    const fileHash = "ab".repeat(32);

    const [first, second] = await Promise.all([
      session?.signFileHash(fileHash),
      session?.signFileHash(fileHash.toUpperCase()),
    ]);

    expect(first).toBe(second);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({
      cwd: dir,
      message: new Uint8Array(Buffer.from(fileHash, "hex")),
    });
    expect(provider.getPublicKey).toHaveBeenCalledWith({ cwd: dir });
    expect(provider.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider that does not match publicKeyPath", async () => {
    const dir = await createTempDir();
    const configured = createKeyPair();
    const providerKey = createKeyPair();
    await fs.writeFile(path.join(dir, "public.pem"), configured.publicKey);
    const provider = {
      name: "wrong-provider",
      publicKeyPath: "public.pem",
      getPublicKey: async () => ({ publicKey: providerKey.publicKey }),
      sign: vi.fn(async () => ({ signature: new Uint8Array([1]) })),
    } satisfies BundleSigningPlugin;

    await expect(prepareBundleSigning(provider, { cwd: dir })).rejects.toThrow(
      "Bundle signing provider public key does not match publicKeyPath.",
    );
    expect(provider.sign).not.toHaveBeenCalled();
  });

  it("rejects non-SPKI provider public keys", async () => {
    const dir = await createTempDir();
    const keyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const pkcs1PublicKey = crypto
      .createPublicKey(keyPair.privateKey)
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    await fs.writeFile(path.join(dir, "public.pem"), keyPair.publicKey);
    const provider = {
      name: "pkcs1-provider",
      publicKeyPath: "public.pem",
      getPublicKey: async () => ({ publicKey: pkcs1PublicKey }),
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningPlugin;

    await expect(prepareBundleSigning(provider, { cwd: dir })).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key.",
    );
  });

  it("rejects RSA public keys weaker than 2048 bits", async () => {
    const dir = await createTempDir();
    const weakKeyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await fs.writeFile(path.join(dir, "public.pem"), weakKeyPair.publicKey);
    const provider = {
      name: "weak-provider",
      publicKeyPath: "public.pem",
      getPublicKey: async () => ({ publicKey: weakKeyPair.publicKey }),
      sign: async ({ message }) => ({
        signature: crypto.sign("RSA-SHA256", message, weakKeyPair.privateKey),
      }),
    } satisfies BundleSigningPlugin;

    await expect(prepareBundleSigning(provider, { cwd: dir })).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key.",
    );
  });

  it("validates hashes and verifies every provider signature", async () => {
    const dir = await createTempDir();
    const { publicKey } = createKeyPair();
    await fs.writeFile(path.join(dir, "public.pem"), publicKey);
    const provider = {
      name: "invalid-signature",
      publicKeyPath: "public.pem",
      getPublicKey: async () => ({ publicKey }),
      sign: vi.fn(async () => ({ signature: new Uint8Array([1, 2, 3]) })),
    } satisfies BundleSigningPlugin;
    const session = await prepareBundleSigning(provider, { cwd: dir });

    await expect(session?.signFileHash("not-a-hash")).rejects.toThrow(
      "Bundle signing requires a 64-character hexadecimal file hash.",
    );
    expect(provider.sign).not.toHaveBeenCalled();
    await expect(session?.signFileHash("ff".repeat(32))).rejects.toThrow(
      "Bundle signing provider returned a signature that does not match the configured public key.",
    );
  });

  it("does not include key material or paths in provider errors", async () => {
    const dir = await createTempDir();
    const publicKeyPath = path.join(dir, "public-secret-name.pem");
    const { publicKey } = createKeyPair();
    await fs.writeFile(publicKeyPath, publicKey);
    const provider = {
      name: "test-provider",
      publicKeyPath,
      getPublicKey: async () => {
        throw new Error("PRIVATE KEY CANARY");
      },
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningPlugin;

    let error: unknown;
    try {
      await prepareBundleSigning(provider);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Failed to resolve the bundle signing provider public key.",
    );
    expect((error as Error).message).not.toContain("PRIVATE KEY CANARY");
    expect((error as Error).message).not.toContain(publicKeyPath);
  });

  it("redacts signing provider failures", async () => {
    const dir = await createTempDir();
    const { publicKey } = createKeyPair();
    await fs.writeFile(path.join(dir, "public.pem"), publicKey);
    const provider = {
      name: "test-provider",
      publicKeyPath: "public.pem",
      getPublicKey: async () => ({ publicKey }),
      sign: async () => {
        throw new Error("PRIVATE KEY CANARY");
      },
    } satisfies BundleSigningPlugin;
    const session = await prepareBundleSigning(provider, { cwd: dir });

    await expect(session?.signFileHash("ab".repeat(32))).rejects.toThrow(
      "Bundle signing provider failed to sign the file hash.",
    );
    await expect(session?.signFileHash("ab".repeat(32))).rejects.not.toThrow(
      "PRIVATE KEY CANARY",
    );
  });
});

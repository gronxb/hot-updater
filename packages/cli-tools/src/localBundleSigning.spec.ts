import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeSigningConfig } from "./localBundleSigning";

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
      publicKeyPath: "./keys/public-key.pem",
      getPublicKey: vi.fn(),
      sign: vi.fn(),
    } satisfies BundleSigningPlugin;

    expect(normalizeSigningConfig(plugin)).toBe(plugin);
    expect(plugin.getPublicKey).not.toHaveBeenCalled();
    expect(plugin.sign).not.toHaveBeenCalled();
  });

  it("normalizes local paths and signs with the private key only on use", async () => {
    const cwd = await createTempDir();
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.mkdir(path.join(cwd, "keys"));
    await fs.writeFile(path.join(cwd, "keys/private-key.pem"), privateKey);

    const signing = normalizeSigningConfig({
      privateKeyPath: "./keys/private-key.pem",
      publicKeyPath: "./keys/public-key.pem",
    });
    const message = crypto.randomBytes(32);

    expect(signing?.name).toBe("localSigning");
    expect(signing?.publicKeyPath).toBe("./keys/public-key.pem");
    expect(signing).not.toHaveProperty("privateKeyPath");
    const { publicKey } = await signing!.getPublicKey({ cwd });
    const { signature } = await signing!.sign({ cwd, message });
    expect(crypto.verify("RSA-SHA256", message, publicKey, signature)).toBe(
      true,
    );
  });

  it("rejects malformed, ambiguous, and legacy local config", () => {
    expect(() =>
      normalizeSigningConfig({
        privateKeyPath: "./private-key.pem",
        publicKeyPath: "",
      }),
    ).toThrow("requires privateKeyPath and publicKeyPath");
    expect(() =>
      normalizeSigningConfig({
        getPublicKey: vi.fn(),
        name: "ambiguous",
        privateKeyPath: "./private-key.pem",
        publicKeyPath: "./public-key.pem",
        sign: vi.fn(),
      } as never),
    ).toThrow("cannot combine a local private key");
    expect(() =>
      normalizeSigningConfig({
        enabled: true,
        privateKeyPath: "./private-key.pem",
        publicKeyPath: "./public-key.pem",
      } as never),
    ).toThrow("accepts only privateKeyPath and publicKeyPath");
  });

  it("redacts local private key read failures", async () => {
    const cwd = await createTempDir();
    const signing = normalizeSigningConfig({
      privateKeyPath: "private-key-canary.pem",
      publicKeyPath: "public-key.pem",
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
    const signing = normalizeSigningConfig({
      privateKeyPath: "private-key.pem",
      publicKeyPath: "public-key.pem",
    });

    await expect(signing?.getPublicKey({ cwd })).rejects.toThrow(
      "Failed to load the local bundle signing private key.",
    );
    await expect(
      signing?.sign({ cwd, message: new Uint8Array(31) }),
    ).rejects.toThrow("messages must be exactly 32 bytes");
  });
});

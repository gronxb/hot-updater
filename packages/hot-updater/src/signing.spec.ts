import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localSigning } from "./signing";

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

describe("localSigning", () => {
  it("derives the public key path and signs without exposing the private key", async () => {
    const cwd = await createTempDir();
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.mkdir(path.join(cwd, "keys"));
    await fs.writeFile(path.join(cwd, "keys/private-key.pem"), privateKey);
    const signing = localSigning({
      privateKeyPath: "./keys/private-key.pem",
    });
    const message = crypto.randomBytes(32);

    const [{ publicKey }, { signature }] = await Promise.all([
      signing.getPublicKey({ cwd }),
      signing.sign({ cwd, message }),
    ]);

    expect(signing.publicKeyPath).toBe("keys/public-key.pem");
    expect(crypto.verify("RSA-SHA256", message, publicKey, signature)).toBe(
      true,
    );
    expect(signing).not.toHaveProperty("privateKeyPath");
  });

  it("redacts invalid private key paths and retries after a failed read", async () => {
    const cwd = await createTempDir();
    const signing = localSigning({ privateKeyPath: "private-canary.pem" });

    await expect(signing.getPublicKey({ cwd })).rejects.toThrow(
      "Failed to load the local bundle signing private key.",
    );
    await expect(signing.getPublicKey({ cwd })).rejects.not.toThrow(
      "private-canary.pem",
    );
  });

  it("allows a checked-in public key path beside an external private key", async () => {
    const signing = localSigning({
      privateKeyPath: "/tmp/hot-updater/private-key.pem",
      publicKeyPath: "./keys/public-key.pem",
    });

    expect(signing.publicKeyPath).toBe("./keys/public-key.pem");
  });

  it("rejects weak keys and messages outside the signing contract", async () => {
    const cwd = await createTempDir();
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.writeFile(path.join(cwd, "private-key.pem"), privateKey);
    const signing = localSigning({ privateKeyPath: "private-key.pem" });

    await expect(signing.getPublicKey({ cwd })).rejects.toThrow(
      "Failed to load the local bundle signing private key.",
    );
    await expect(
      signing.sign({ cwd, message: new Uint8Array(31) }),
    ).rejects.toThrow("messages must be exactly 32 bytes");
  });

  it("rejects an empty explicit public key path", () => {
    expect(() =>
      localSigning({
        privateKeyPath: "private-key.pem",
        publicKeyPath: " ",
      }),
    ).toThrow("requires publicKeyPath when provided");
  });
});

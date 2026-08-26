// @vitest-environment node

import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectBundleSigning } from "./bundle-signing.server";

const temporaryDirectories: string[] = [];

const createKeyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hot-updater-signing-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bundle signing inspection", () => {
  it("returns only canonical public metadata for an RSA SPKI key", async () => {
    const directory = await createTemporaryDirectory();
    const { privateKey, publicKey } = createKeyPair();
    const publicKeyPath = path.join(directory, "public-key.pem");
    await writeFile(publicKeyPath, publicKey);

    const inspection = await inspectBundleSigning({
      enabled: true,
      provider: "Local file",
      publicKeyPath,
    });
    const publicKeyObject = createPublicKey(publicKey);
    const expectedFingerprint = createHash("sha256")
      .update(publicKeyObject.export({ format: "der", type: "spki" }))
      .digest("hex");

    expect(inspection).toEqual({
      algorithm: "RSA-SHA256",
      fingerprint: expectedFingerprint,
      provider: "Local file",
      publicKey: publicKey.trim(),
      status: "enabled",
    });
    expect(JSON.stringify(inspection)).not.toContain(privateKey);
    expect(JSON.stringify(inspection)).not.toContain(publicKeyPath);
  });

  it("refuses to derive a public key from private key contents", async () => {
    const directory = await createTemporaryDirectory();
    const { privateKey } = createKeyPair();
    const publicKeyPath = path.join(directory, "public-key.pem");
    await writeFile(publicKeyPath, privateKey);

    await expect(
      inspectBundleSigning({
        enabled: true,
        provider: "Local file",
        publicKeyPath,
      }),
    ).resolves.toEqual({
      message: "The configured public key is not a valid SPKI public key.",
      provider: "Local file",
      status: "misconfigured",
    });
  });

  it("rejects an RSA public key weaker than 2048 bits", async () => {
    const directory = await createTemporaryDirectory();
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const publicKeyPath = path.join(directory, "public-key.pem");
    await writeFile(publicKeyPath, publicKey);

    await expect(
      inspectBundleSigning({
        enabled: true,
        provider: "Weak signer",
        publicKeyPath,
      }),
    ).resolves.toEqual({
      message: "The configured RSA public key must be at least 2048 bits.",
      provider: "Weak signer",
      status: "misconfigured",
    });
  });

  it("returns a path-free fixed error when the public key is unavailable", async () => {
    const publicKeyPath = "/secret/provider/missing-public-key.pem";
    const inspection = await inspectBundleSigning({
      enabled: true,
      provider: "Managed signing",
      publicKeyPath,
    });

    expect(inspection).toEqual({
      message: "The configured public key could not be loaded.",
      provider: "Managed signing",
      status: "misconfigured",
    });
    expect(JSON.stringify(inspection)).not.toContain(publicKeyPath);
  });

  it("reports disabled without accessing any key material", async () => {
    await expect(
      inspectBundleSigning({
        enabled: false,
      }),
    ).resolves.toEqual({ status: "disabled" });
  });
});

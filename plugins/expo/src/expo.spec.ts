import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock("./expoConfig", () => ({
  getConfig: mocks.getConfig,
}));

import {
  getExpoBundleSigningPublicKey,
  getExpoFingerprintExtraSources,
} from "./expo";

const tempDirs: string[] = [];

const createProject = async (publicKeyPath?: string) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-signing-config-"));
  tempDirs.push(cwd);
  mocks.getConfig.mockReturnValue({
    exp: {
      plugins: [
        [
          "@hot-updater/expo",
          publicKeyPath === undefined ? {} : { publicKeyPath },
        ],
      ],
    },
  });
  return cwd;
};

beforeEach(() => {
  mocks.getConfig.mockReset();
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("getExpoBundleSigningPublicKey", () => {
  it("resolves the trust anchor from the evaluated Expo plugin config", async () => {
    const cwd = await createProject("keys/public-key.pem");
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await fs.mkdir(path.join(cwd, "keys"));
    await fs.writeFile(path.join(cwd, "keys/public-key.pem"), publicKey);

    await expect(getExpoBundleSigningPublicKey(cwd)).resolves.toEqual({
      publicKey,
    });
  });

  it("returns null when the Expo plugin has no trust anchor", async () => {
    const cwd = await createProject();

    await expect(getExpoBundleSigningPublicKey(cwd)).resolves.toBeNull();
  });

  it("fails when the configured trust anchor cannot be loaded", async () => {
    const cwd = await createProject("keys/missing.pem");

    await expect(getExpoBundleSigningPublicKey(cwd)).rejects.toThrow(
      "Failed to read the bundle signing public key file.",
    );
  });
});

describe("getExpoFingerprintExtraSources", () => {
  it("includes the configured trust anchor in native fingerprints", async () => {
    const cwd = await createProject("keys/public-key.pem");

    await expect(getExpoFingerprintExtraSources(cwd)).resolves.toEqual([
      "keys/public-key.pem",
    ]);
  });

  it("adds no source when bundle signing is not configured", async () => {
    const cwd = await createProject();

    await expect(getExpoFingerprintExtraSources(cwd)).resolves.toEqual([]);
  });
});

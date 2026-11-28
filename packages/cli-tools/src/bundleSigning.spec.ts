import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter, SigningConfig } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBundleSigningPublicKey,
  prepareBundleSigning,
  readBundleSigningPublicKeyFile,
  readBundleSigningState,
} from "./bundleSigning";
import { maskSecretValues } from "./secretMasking";
import { resolveSecretsAdapter, secret, setConfiguredSecrets } from "./secrets";

const tempDirs: string[] = [];

const createKeyPair = (modulusLength = 2048) =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-signing-"));
  tempDirs.push(dir);
  return dir;
};

/** A secrets adapter holding `values`, recording each read. */
const fakeSecrets = (values: Record<string, string>) => {
  const get = vi.fn<SecretsAdapter["get"]>(async (names) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  );
  const secrets: SecretsAdapter = {
    name: "fake",
    set: async () => {},
    get,
    describe: (name) => `fake://store/${name}`,
  };
  return { get, secrets };
};

/** Whether `signature` verifies over `fileHash` with `publicKey`, by node:crypto. */
const verifies = (fileHash: string, publicKey: string, signature: string) =>
  crypto.verify(
    "RSA-SHA256",
    Buffer.from(fileHash, "hex"),
    publicKey,
    Buffer.from(signature, "base64"),
  );

afterEach(async () => {
  setConfiguredSecrets(resolveSecretsAdapter());
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("readBundleSigningState", () => {
  it("reads the shorthand as enabled signing with the secret's key", () => {
    expect(readBundleSigningState(secret("bundle-signing-key"))).toEqual({
      status: "on",
      key: { secret: "bundle-signing-key" },
    });
    expect(
      readBundleSigningState({
        enabled: true,
        privateKey: secret("bundle-signing-key"),
      }),
    ).toEqual({ status: "on", key: { secret: "bundle-signing-key" } });
  });

  it("keeps 1.1's privateKeyPath", () => {
    expect(
      readBundleSigningState({
        enabled: true,
        privateKeyPath: "./keys/private-key.pem",
      }),
    ).toEqual({
      status: "on",
      key: { privateKeyPath: "./keys/private-key.pem" },
    });
  });

  it("tells an omitted signing from one turned off", () => {
    expect(readBundleSigningState(undefined)).toEqual({ status: "unsigned" });
    expect(readBundleSigningState({ enabled: false })).toEqual({
      status: "off",
    });
    expect(
      readBundleSigningState({
        enabled: false,
        privateKeyPath: "/missing/key.pem",
      }),
    ).toEqual({ status: "off" });
  });

  it("refuses a signing adapter and any other value in one line", () => {
    const adapter = {
      name: "awsKmsSigning",
      getPublicKey: vi.fn(),
      sign: vi.fn(),
    };
    for (const value of [adapter, "bundle-signing-key", null, true, () => ""]) {
      expect(readBundleSigningState(value)).toEqual({
        status: "invalid",
        message: 'signing takes secret("bundle-signing-key").',
      });
    }
    expect(adapter.getPublicKey).not.toHaveBeenCalled();
    expect(adapter.sign).not.toHaveBeenCalled();
  });

  it("refuses a malformed object form", () => {
    expect(
      readBundleSigningState({ privateKeyPath: "/missing/key.pem" }),
    ).toMatchObject({ status: "invalid" });
    expect(
      readBundleSigningState({
        enabled: true,
        privateKeyPath: "./private-key.pem",
        publicKeyPath: "./public-key.pem",
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      readBundleSigningState({ enabled: true, privateKeyPath: "" }),
    ).toEqual({
      status: "invalid",
      message:
        'signing takes privateKeyPath, or privateKey as secret("<name>").',
    });
    expect(
      readBundleSigningState({ enabled: true, privateKey: "key" }),
    ).toEqual({
      status: "invalid",
      message: 'signing.privateKey takes secret("<name>").',
    });
    expect(
      readBundleSigningState({
        enabled: true,
        privateKey: secret("bundle-signing-key"),
        privateKeyPath: "./keys/private-key.pem",
      }),
    ).toEqual({
      status: "invalid",
      message: "signing takes privateKey or privateKeyPath, not both.",
    });
  });
});

describe("prepareBundleSigning", () => {
  it("signs nothing when omitted or turned off, reading no key", async () => {
    await expect(prepareBundleSigning(undefined)).resolves.toBeNull();
    await expect(
      prepareBundleSigning({
        enabled: false,
        privateKeyPath: "/missing/key.pem",
      }),
    ).resolves.toBeNull();
  });

  it("refuses a signing adapter with the next step, never deploying unsigned", async () => {
    await expect(
      prepareBundleSigning({
        name: "remoteSigning",
        getPublicKey: async () => ({ publicKey: "" }),
        sign: async () => ({ signature: new Uint8Array() }),
      }),
    ).rejects.toThrow(
      'signing takes secret("bundle-signing-key").\nStore your key: npx hot-updater secrets put bundle-signing-key <key.pem>',
    );
  });

  it("signs with 1.1's privateKeyPath, memoizing each file hash", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    await fs.writeFile(path.join(cwd, "custom-private.pem"), privateKey);
    const session = await prepareBundleSigning(
      { enabled: true, privateKeyPath: "custom-private.pem" },
      { cwd },
    );
    const fileHash = "ab".repeat(32);
    const signature = await session!.signFileHash(fileHash);

    expect(session!.publicKey).toBe(publicKey);
    expect(verifies(fileHash, publicKey, signature)).toBe(true);
    await expect(session!.signFileHash(fileHash.toUpperCase())).resolves.toBe(
      signature,
    );
    await expect(session!.signFileHash("not-a-hash")).rejects.toThrow(
      "64-character hexadecimal file hash",
    );
  });

  it("redacts a privateKeyPath it can't read, and refuses a weak key", async () => {
    const cwd = await createTempDir();
    await fs.writeFile(
      path.join(cwd, "weak.pem"),
      createKeyPair(1024).privateKey,
    );
    for (const privateKeyPath of ["private-key-canary.pem", "weak.pem"]) {
      const error = await prepareBundleSigning(
        { enabled: true, privateKeyPath },
        { cwd },
      ).catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Failed to load the bundle signing private key from privateKeyPath.",
      );
    }
  });

  it("signs with the shorthand's key, read once from the config's secrets", async () => {
    const { privateKey, publicKey } = createKeyPair();
    const { get, secrets } = fakeSecrets({ "bundle-signing-key": privateKey });
    const signing: SigningConfig = secret("bundle-signing-key");

    await expect(
      getBundleSigningPublicKey(signing, { cwd: "/project", secrets }),
    ).resolves.toBe(publicKey);
    const session = await prepareBundleSigning(signing, {
      cwd: "/project",
      secrets,
    });
    const fileHash = "a".repeat(64);

    expect(session?.publicKey).toBe(publicKey);
    expect(
      verifies(fileHash, publicKey, await session!.signFileHash(fileHash)),
    ).toBe(true);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(["bundle-signing-key"], {
      cwd: "/project",
    });
  });

  it("reads the key from the configured secrets without one given", async () => {
    const { privateKey, publicKey } = createKeyPair();
    setConfiguredSecrets(
      fakeSecrets({ "bundle-signing-key": privateKey }).secrets,
    );

    await expect(
      getBundleSigningPublicKey(
        { enabled: true, privateKey: secret("bundle-signing-key") },
        { cwd: "/project" },
      ),
    ).resolves.toBe(publicKey);
  });

  it("reads each platform's key from that config's secrets", async () => {
    const ios = createKeyPair();
    const android = createKeyPair();
    const signing = secret("bundle-signing-key");

    await expect(
      getBundleSigningPublicKey(signing, {
        cwd: "/project",
        secrets: fakeSecrets({ "bundle-signing-key": ios.privateKey }).secrets,
      }),
    ).resolves.toBe(ios.publicKey);
    await expect(
      getBundleSigningPublicKey(signing, {
        cwd: "/project",
        secrets: fakeSecrets({ "bundle-signing-key": android.privateKey })
          .secrets,
      }),
    ).resolves.toBe(android.publicKey);
  });

  it("masks the key it reads in the CLI's output", async () => {
    const { privateKey } = createKeyPair();
    const { secrets } = fakeSecrets({ "masked-key": privateKey });
    const body = privateKey.split("\n")[1]!;
    expect(maskSecretValues(`line ${body}`)).toContain(body);

    await getBundleSigningPublicKey(secret("masked-key"), {
      cwd: "/project",
      secrets,
    });

    expect(maskSecretValues(`line ${body}`)).toBe("line ********");
  });

  it("reads a one-line PEM from .env.hotupdater, with \\n for its line breaks", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    await fs.writeFile(
      path.join(cwd, ".env.hotupdater"),
      `HOT_UPDATER_ENV_SIGNING_KEY=${JSON.stringify(privateKey)}\n`,
    );

    await expect(
      getBundleSigningPublicKey(secret("env-signing-key"), {
        cwd,
        secrets: resolveSecretsAdapter(),
      }),
    ).resolves.toBe(publicKey);
  });

  it("points a missing key at importing it, never at a new key shipped apps reject", async () => {
    const { secrets } = fakeSecrets({});

    const missing = (await prepareBundleSigning(secret("bundle-signing-key"), {
      cwd: "/project",
      secrets,
    }).catch((error: unknown) => error)) as Error;
    expect(missing.message).toBe(
      [
        "bundle-signing-key isn't in the fake secrets adapter.",
        "Check the name and your access, or import your key:",
        "npx hot-updater secrets put bundle-signing-key <key.pem>",
      ].join("\n"),
    );
    const named = (await prepareBundleSigning(secret("release-signing-key"), {
      cwd: "/project",
      secrets,
    }).catch((error: unknown) => error)) as Error;
    expect(named.message).toContain(
      "npx hot-updater secrets put release-signing-key --kind bundle-signing-key <key.pem>",
    );
    for (const { message } of [missing, named]) {
      expect(message).not.toContain("secrets issue");
    }
  });

  it("names localSecrets()'s variable and file when neither has the key", async () => {
    const cwd = await createTempDir();

    await expect(
      prepareBundleSigning(secret("bundle-signing-key"), {
        cwd,
        secrets: resolveSecretsAdapter(),
      }),
    ).rejects.toThrow(
      [
        "bundle-signing-key isn't on this machine.",
        "Check the name, set HOT_UPDATER_BUNDLE_SIGNING_KEY, or import your key:",
        "npx hot-updater secrets put bundle-signing-key <key.pem>",
      ].join("\n"),
    );
  });

  it("reports an unreadable store, and refuses a value that is no key without quoting it", async () => {
    const failing: SecretsAdapter = {
      name: "fake",
      set: async () => {},
      get: async () => {
        throw new Error("permission denied");
      },
    };
    await expect(
      prepareBundleSigning(secret("bundle-signing-key"), {
        cwd: "/project",
        secrets: failing,
      }),
    ).rejects.toThrow(
      "Couldn't read bundle-signing-key from the fake secrets adapter.\npermission denied",
    );

    for (const value of [
      "not-a-pem-canary-value",
      createKeyPair(1024).privateKey,
    ]) {
      const error = await prepareBundleSigning(secret("bundle-signing-key"), {
        cwd: "/project",
        secrets: fakeSecrets({ "bundle-signing-key": value }).secrets,
      }).catch((caught: unknown) => caught as Error);
      expect((error as Error).message).toBe(
        "bundle-signing-key in the fake secrets adapter is no signing key.\nStore an RSA private key in PEM, of 2048 bits or more.",
      );
      expect((error as Error).message).not.toContain(value.slice(0, 20));
    }
  });

  it("reads the secret again after a failed read", async () => {
    const { privateKey } = createKeyPair();
    const values: Record<string, string> = {};
    const { get, secrets } = fakeSecrets(values);
    const signing = secret("bundle-signing-key");
    await expect(
      getBundleSigningPublicKey(signing, { cwd: "/project", secrets }),
    ).rejects.toThrow("isn't in the fake secrets adapter");

    values["bundle-signing-key"] = privateKey;
    await expect(
      getBundleSigningPublicKey(signing, { cwd: "/project", secrets }),
    ).resolves.toContain("BEGIN PUBLIC KEY");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("getBundleSigningPublicKey", () => {
  it("derives the public key only from the private key", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    await fs.writeFile(path.join(cwd, "private-key.pem"), privateKey);

    await expect(
      getBundleSigningPublicKey(
        { enabled: true, privateKeyPath: "private-key.pem" },
        { cwd },
      ),
    ).resolves.toBe(publicKey);
    await fs.unlink(path.join(cwd, "private-key.pem"));
    await fs.writeFile(path.join(cwd, "public-key.pem"), publicKey);
    await expect(
      getBundleSigningPublicKey(
        { enabled: true, privateKeyPath: "private-key.pem" },
        { cwd },
      ),
    ).rejects.toThrow("Failed to load the bundle signing private key");
  });

  it("returns null when signing is off or omitted", async () => {
    await expect(
      getBundleSigningPublicKey({ enabled: false }),
    ).resolves.toBeNull();
    await expect(getBundleSigningPublicKey(undefined)).resolves.toBeNull();
  });
});

describe("readBundleSigningPublicKeyFile", () => {
  it("loads and canonicalizes an Expo native trust anchor", async () => {
    const cwd = await createTempDir();
    const { publicKey } = createKeyPair();
    await fs.writeFile(path.join(cwd, "public.pem"), publicKey);

    await expect(
      readBundleSigningPublicKeyFile("public.pem", { cwd }),
    ).resolves.toBe(publicKey);
  });

  it("rejects missing and invalid public key files without exposing paths", async () => {
    const cwd = await createTempDir();
    await fs.writeFile(path.join(cwd, "invalid.pem"), "not a public key");

    await expect(
      readBundleSigningPublicKeyFile("invalid.pem", { cwd }),
    ).rejects.toThrow("Failed to read the bundle signing public key file.");
    await expect(
      readBundleSigningPublicKeyFile("secret-path.pem", { cwd }),
    ).rejects.not.toThrow("secret-path.pem");
  });
});

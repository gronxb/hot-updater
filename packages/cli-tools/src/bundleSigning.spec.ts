import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BundleSigningAdapter,
  SecretsAdapter,
  SigningConfig,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBundleSigningPublicKey,
  prepareBundleSigning,
  readBundleSigningPublicKeyFile,
} from "./bundleSigning";
import { normalizeSigningConfig } from "./localBundleSigning";
import { setConfiguredSecrets, resolveSecretsAdapter } from "./secrets";

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
  it("disables signing when omitted or explicitly disabled without reading keys", async () => {
    await expect(prepareBundleSigning(undefined)).resolves.toBeNull();
    await expect(
      prepareBundleSigning({
        enabled: false,
        privateKeyPath: "/missing/key.pem",
      }),
    ).resolves.toBeNull();
  });

  it("signs with a local private key config without requiring a public key file", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    await fs.writeFile(path.join(cwd, "custom-private.pem"), privateKey);
    const session = await prepareBundleSigning(
      { enabled: true, privateKeyPath: "custom-private.pem" },
      { cwd },
    );
    const fileHash = "ab".repeat(32);
    const signature = await session!.signFileHash(fileHash);
    expect(session!.name).toBe("localSigning");
    expect(session!.publicKey).toBe(publicKey);
    expect(signature).toBe(
      crypto
        .sign("RSA-SHA256", Buffer.from(fileHash, "hex"), privateKey)
        .toString("base64"),
    );
  });

  it("uses the provider public key and memoizes each file hash", async () => {
    const dir = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    const sign = vi.fn(async ({ message }: { message: Uint8Array }) => ({
      signature: crypto.sign("RSA-SHA256", message, privateKey),
    }));
    const provider = {
      name: "test-provider",
      getPublicKey: vi.fn(async () => ({ publicKey })),
      sign,
    } satisfies BundleSigningAdapter;
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
    const provider = {
      name: "pkcs1-provider",
      getPublicKey: async () => ({ publicKey: pkcs1PublicKey }),
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningAdapter;

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
    const provider = {
      name: "weak-provider",
      getPublicKey: async () => ({ publicKey: weakKeyPair.publicKey }),
      sign: async ({ message }) => ({
        signature: crypto.sign("RSA-SHA256", message, weakKeyPair.privateKey),
      }),
    } satisfies BundleSigningAdapter;

    await expect(prepareBundleSigning(provider, { cwd: dir })).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key.",
    );
  });

  it("validates hashes and verifies every provider signature", async () => {
    const dir = await createTempDir();
    const { publicKey } = createKeyPair();
    const provider = {
      name: "invalid-signature",
      getPublicKey: async () => ({ publicKey }),
      sign: vi.fn(async () => ({ signature: new Uint8Array([1, 2, 3]) })),
    } satisfies BundleSigningAdapter;
    const session = await prepareBundleSigning(provider, { cwd: dir });

    await expect(session?.signFileHash("not-a-hash")).rejects.toThrow(
      "Bundle signing requires a 64-character hexadecimal file hash.",
    );
    expect(provider.sign).not.toHaveBeenCalled();
    await expect(session?.signFileHash("ff".repeat(32))).rejects.toThrow(
      "Bundle signing provider returned a signature that does not match the configured public key.",
    );
  });

  it("does not include provider key material in errors", async () => {
    const provider = {
      name: "test-provider",
      getPublicKey: async () => {
        throw new Error("PRIVATE KEY CANARY");
      },
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningAdapter;

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
  });

  it("shows the reasons remoteSigning names, and redacts every other provider error", async () => {
    const dir = await createTempDir();
    const { publicKey } = createKeyPair();
    const refusal = (message: string) =>
      Object.assign(new Error(message), {
        name: "HotUpdaterRemoteSigningError",
      });
    const refusing = {
      name: "remoteSigning",
      getPublicKey: async () => {
        throw refusal(
          "Failed to load the remote bundle signing public key. https://signer.example.com/sign answered 401 unauthorized: The signing token was revoked.",
        );
      },
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningAdapter;
    await expect(prepareBundleSigning(refusing, { cwd: dir })).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key. Failed to load the remote bundle signing public key. https://signer.example.com/sign answered 401 unauthorized: The signing token was revoked.",
    );

    const signRefusing = {
      name: "remoteSigning",
      getPublicKey: async () => ({ publicKey }),
      sign: async () => {
        throw refusal(
          "Remote bundle signer failed to sign the message. https://signer.example.com/sign answered 503 unavailable: The signer is down.",
        );
      },
    } satisfies BundleSigningAdapter;
    const session = await prepareBundleSigning(signRefusing, { cwd: dir });
    await expect(session?.signFileHash("ff".repeat(32))).rejects.toThrow(
      "Bundle signing provider failed to sign the file hash. Remote bundle signer failed to sign the message. https://signer.example.com/sign answered 503 unavailable: The signer is down.",
    );

    const leaking = {
      name: "test-provider",
      getPublicKey: async () => {
        throw new Error("PRIVATE KEY CANARY");
      },
      sign: async () => ({ signature: new Uint8Array([1]) }),
    } satisfies BundleSigningAdapter;
    const error = await prepareBundleSigning(leaking, { cwd: dir }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toBe(
      "Failed to resolve the bundle signing provider public key.",
    );
  });

  it("redacts signing provider failures", async () => {
    const dir = await createTempDir();
    const { publicKey } = createKeyPair();
    const provider = {
      name: "test-provider",
      getPublicKey: async () => ({ publicKey }),
      sign: async () => {
        throw new Error("PRIVATE KEY CANARY");
      },
    } satisfies BundleSigningAdapter;
    const session = await prepareBundleSigning(provider, { cwd: dir });

    await expect(session?.signFileHash("ab".repeat(32))).rejects.toThrow(
      "Bundle signing provider failed to sign the file hash.",
    );
    await expect(session?.signFileHash("ab".repeat(32))).rejects.not.toThrow(
      "PRIVATE KEY CANARY",
    );
  });
});

describe("getBundleSigningPublicKey", () => {
  it("derives the local public key only from the configured private key", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createKeyPair();
    const signing = {
      enabled: true,
      privateKeyPath: "private-key.pem",
    } as const;
    await fs.writeFile(path.join(cwd, "private-key.pem"), privateKey);
    await expect(getBundleSigningPublicKey(signing, { cwd })).resolves.toBe(
      publicKey,
    );
    await fs.unlink(path.join(cwd, "private-key.pem"));
    await fs.writeFile(path.join(cwd, "public-key.pem"), publicKey);
    await expect(getBundleSigningPublicKey(signing, { cwd })).rejects.toThrow(
      "Failed to resolve",
    );
  });

  it("returns null when signing is disabled", async () => {
    const cwd = await createTempDir();
    await expect(
      getBundleSigningPublicKey({ enabled: false }, { cwd }),
    ).resolves.toBeNull();
  });
});

describe("local signing with privateKey from the config's secrets", () => {
  afterEach(() => setConfiguredSecrets(resolveSecretsAdapter()));

  const configure = (values: Record<string, string>) => {
    const get = vi.fn<SecretsAdapter["get"]>(async (names) =>
      Object.fromEntries(names.map((name) => [name, values[name]])),
    );
    setConfiguredSecrets({ name: "fake", get, set: async () => {} });
    return get;
  };

  it("reads the key once for the public key and every signature of a run", async () => {
    const { privateKey, publicKey } = createKeyPair();
    const get = configure({ "bundle-signing-key": privateKey });
    const signing: SigningConfig = {
      enabled: true,
      privateKey: "secret:bundle-signing-key",
    };

    await expect(
      getBundleSigningPublicKey(signing, { cwd: "/project" }),
    ).resolves.toBe(publicKey);
    const session = await prepareBundleSigning(signing, { cwd: "/project" });
    const fileHash = "a".repeat(64);
    const signature = await session!.signFileHash(fileHash);

    expect(session?.publicKey).toBe(publicKey);
    expect(
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(fileHash, "hex"),
        publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
    expect(get).toHaveBeenCalledOnce();
  });

  it("reads each config's key from that config's secrets, whichever loaded last", async () => {
    const ios = createKeyPair();
    const android = createKeyPair();
    const store = (name: string, privateKey: string): SecretsAdapter => ({
      name,
      set: async () => {},
      get: async (names) =>
        Object.fromEntries(names.map((entry) => [entry, privateKey])),
    });
    const raw = {
      enabled: true,
      privateKey: "secret:bundle-signing-key",
    } as const;
    const iosSigning = normalizeSigningConfig(raw, {
      secrets: store("ios-store", ios.privateKey),
    });
    const androidSigning = normalizeSigningConfig(raw, {
      secrets: store("android-store", android.privateKey),
    });
    // The global adapter is the last config's, as loadConfig leaves it.
    configure({});

    await expect(
      getBundleSigningPublicKey(iosSigning, { cwd: "/project" }),
    ).resolves.toBe(ios.publicKey);
    await expect(
      getBundleSigningPublicKey(androidSigning, { cwd: "/project" }),
    ).resolves.toBe(android.publicKey);
  });

  it("refuses a deploy whose secret is missing, naming it", async () => {
    configure({});

    await expect(
      prepareBundleSigning(
        { enabled: true, privateKey: "secret:bundle-signing-key" },
        { cwd: "/project" },
      ),
    ).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key. signing.privateKey reads the bundle signing key bundle-signing-key, which is not in the fake secrets adapter (bundle-signing-key in fake).",
    );
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

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BundleSigningAdapter,
  SecretsAdapter,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalSigningAdapter,
  normalizeSigningConfig,
} from "./localBundleSigning";
import { maskSecretValues } from "./secretMasking";
import { withLocalKeyStore } from "./secrets";

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
  it("keeps an explicit signing adapter unchanged", () => {
    const plugin = {
      name: "test-signer",
      getPublicKey: vi.fn(),
      sign: vi.fn(),
    } satisfies BundleSigningAdapter;

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
    ).toThrow("must be a local key config or signing adapter");
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

    const signing = createLocalSigningAdapter({
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
    ).toThrow("accepts only enabled, and privateKeyPath or privateKey");
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
    const signing = createLocalSigningAdapter({
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
    const signing = createLocalSigningAdapter({
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

const createPem = (modulusLength = 2048) =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

/** A secrets adapter holding `values`, recording each read. */
const fakeSecrets = (values: Record<string, string>) => {
  const get = vi.fn<SecretsAdapter["get"]>(async (names) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  );
  const secrets: SecretsAdapter = {
    name: "fake",
    get,
    describe: (name) => `fake://store/${name}`,
  };
  return { get, secrets };
};

describe("local signing with privateKey from a secret", () => {
  it("keeps the secret reference without reading it during normalization", () => {
    const local = {
      enabled: true,
      privateKey: "secret:bundle-signing-key",
    } as const;
    expect(normalizeSigningConfig(local)).toEqual(local);
  });

  it("refuses a malformed reference, and both key sources at once", () => {
    expect(() =>
      normalizeSigningConfig({
        enabled: true,
        privateKey: "bundle-signing-key",
      } as never),
    ).toThrow("signing.privateKey names a secret as secret:<name>");
    expect(() =>
      normalizeSigningConfig({
        enabled: true,
        privateKey: "secret:bundle-signing-key",
        privateKeyPath: "./keys/private-key.pem",
      } as never),
    ).toThrow("privateKeyPath or from privateKey, not both");
  });

  it("signs with the key the secrets adapter holds, reading it once", async () => {
    const { privateKey, publicKey } = createPem();
    const { get, secrets } = fakeSecrets({ "bundle-signing-key": privateKey });
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:bundle-signing-key" },
      { secrets },
    );
    const message = crypto.randomBytes(32);

    const derived = await signing.getPublicKey({ cwd: "/project" });
    const { signature } = await signing.sign({ cwd: "/project", message });

    expect(derived.publicKey).toBe(publicKey);
    expect(crypto.verify("RSA-SHA256", message, publicKey, signature)).toBe(
      true,
    );
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(["bundle-signing-key"], {
      cwd: "/project",
    });
  });

  it("masks the resolved key in the CLI's output", async () => {
    const { privateKey } = createPem();
    const { secrets } = fakeSecrets({ "masked-key": privateKey });
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:masked-key" },
      { secrets },
    );
    const body = privateKey.split("\n")[1]!;
    expect(maskSecretValues(`line ${body}`)).toContain(body);

    await signing.getPublicKey({ cwd: "/project" });

    expect(maskSecretValues(privateKey)).not.toContain(body);
    expect(maskSecretValues(`line ${body}`)).toBe("line ********");
  });

  it("reads a one-line PEM from the environment, with \\n for its line breaks", async () => {
    const cwd = await createTempDir();
    const { privateKey, publicKey } = createPem();
    await fs.writeFile(
      path.join(cwd, ".env.hotupdater"),
      `HOT_UPDATER_ENV_SIGNING_KEY=${JSON.stringify(privateKey)}\n`,
    );
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:env-signing-key" },
      { secrets: withLocalKeyStore() },
    );

    await expect(signing.getPublicKey({ cwd })).resolves.toEqual({
      publicKey,
    });
  });

  it("names the missing secret, where it is read, and how to store it", async () => {
    const { secrets } = fakeSecrets({});
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:release-signing-key" },
      { secrets },
    );

    await expect(signing.getPublicKey({ cwd: "/project" })).rejects.toThrow(
      "signing.privateKey reads the bundle signing key release-signing-key, which is not in the fake secrets adapter (fake://store/release-signing-key). Set it to the RSA private key in PEM, or generate a key pair with `npx hot-updater keys generate --secret release-signing-key`.",
    );
  });

  it("names the default store's variable and key store file when neither has the key", async () => {
    const cwd = await createTempDir();
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:bundle-signing-key" },
      { secrets: withLocalKeyStore() },
    );

    await expect(signing.getPublicKey({ cwd })).rejects.toThrow(
      "(HOT_UPDATER_BUNDLE_SIGNING_KEY in the environment, or ",
    );
  });

  it("reports an unreadable store, and refuses a value that is no key without quoting it", async () => {
    const failing: SecretsAdapter = {
      name: "fake",
      get: async () => {
        throw new Error("permission denied");
      },
    };
    await expect(
      createLocalSigningAdapter(
        { enabled: true, privateKey: "secret:bundle-signing-key" },
        { secrets: failing },
      ).getPublicKey({ cwd: "/project" }),
    ).rejects.toThrow(
      "The fake secrets adapter could not read the bundle signing key bundle-signing-key: permission denied",
    );

    const weak = createPem(1024).privateKey;
    for (const value of ["not-a-pem-canary-value", weak]) {
      const { secrets } = fakeSecrets({ "bundle-signing-key": value });
      const error = await createLocalSigningAdapter(
        { enabled: true, privateKey: "secret:bundle-signing-key" },
        { secrets },
      )
        .getPublicKey({ cwd: "/project" })
        .catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "The bundle signing key bundle-signing-key in the fake secrets adapter is not an RSA private key in PEM of at least 2048 bits.",
      );
      expect((error as Error).message).not.toContain(value.slice(0, 20));
    }
  });

  it("reads the secret again after a failed read", async () => {
    const { privateKey } = createPem();
    const values: Record<string, string> = {};
    const { get, secrets } = fakeSecrets(values);
    const signing = createLocalSigningAdapter(
      { enabled: true, privateKey: "secret:bundle-signing-key" },
      { secrets },
    );
    await expect(signing.getPublicKey({ cwd: "/project" })).rejects.toThrow(
      "not in the fake secrets adapter",
    );

    values["bundle-signing-key"] = privateKey;
    await expect(signing.getPublicKey({ cwd: "/project" })).resolves.toEqual({
      publicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

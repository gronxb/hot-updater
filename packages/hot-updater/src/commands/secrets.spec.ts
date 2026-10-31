import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  getLocalKeyFile,
  loadConfig,
  maskSecretValues,
  resolveSecretsAdapter,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSecretsPut } from "./secrets";

const { log, password, printBanner, text } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  password: vi.fn(),
  printBanner: vi.fn(),
  text: vi.fn(),
}));

// Only the config, the prompts, and the JDK are mocked.
const jdkRuns = vi.hoisted(
  () => [] as { args: readonly string[]; tool: string }[],
);
vi.mock("../utils/native/androidKeystore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/androidKeystore")>()),
  // A JDK that opens any keystore: uploadKey.spec.ts checks the passwords.
  findKeytool: vi.fn(
    async () =>
      async (args: readonly string[], _env?: unknown, tool = "keytool") => {
        jdkRuns.push({ args, tool });
        return {
          exitCode: 0,
          stdout:
            args[0] === "-exportcert"
              ? "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
              : "",
          stderr: "",
        };
      },
  ),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: {
    isCancel: vi.fn(() => false),
    log,
    password,
    text,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));
const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49putSpecKeyLine01\n-----END PRIVATE KEY-----";

const messages = () =>
  log.success.mock.calls.map(([text]) =>
    stripVTControlCharacters(String(text)),
  );

/** A writable secrets adapter the config sets, holding what `put` stores. */
const writableStore = (values: Record<string, string> = {}) => {
  const held = new Map(Object.entries(values));
  const store = {
    name: "spec-store",
    describe: (name: string) => `spec://${name}`,
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, held.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      held.set(name, value);
    }),
  } satisfies SecretsAdapter;
  configure(store);
  return { store, held };
};

/** Makes `secrets` the config's, as loadConfig hands it over: `localSecrets()` without one. */
const configure = (secrets?: SecretsAdapter) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: resolveSecretsAdapter(secrets),
  } as never);
};

let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-secrets-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(directory, "home"));
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

/** An RSA key pair, its private key as `format` PEM. */
const rsaKey = (bits: number, type: "pkcs1" | "pkcs8") => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: bits,
  });
  return {
    pem: privateKey.export({ type, format: "pem" }).toString(),
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    // As keys names a key: SHA-256 of its SPKI DER.
    fingerprint: `sha256:${crypto
      .createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`,
  };
};

describe("hot-updater secrets put bundle-signing-key", () => {
  it.each(["pkcs1", "pkcs8"] as const)(
    "moves an existing %s key into the store as the PKCS#8 local signing reads, read back, masked, and named by its fingerprint",
    async (type) => {
      // Given: a privateKeyPath key of 1.0
      const { store, held } = writableStore();
      const key = rsaKey(2048, type);
      const file = path.join(directory, "private-key.pem");
      await fs.writeFile(file, key.pem);

      // When
      await handleSecretsPut("bundle-signing-key", { file });

      // Then
      expect(process.exitCode).toBeUndefined();
      expect(held.get("bundle-signing-key")).toBe(key.pkcs8);
      // Read back once after storing it.
      expect(store.get).toHaveBeenCalledWith(
        ["bundle-signing-key"],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      const line = key.pkcs8.split("\n")[1]!;
      expect(maskSecretValues(`key ${line}`)).not.toContain(line);
      const [stored] = messages();
      expect(stored).toContain(key.fingerprint);
      expect(stored).not.toContain(line);
      expect(stored).not.toContain(key.pem.split("\n")[1]!);
    },
  );

  it("takes another name with --kind", async () => {
    const { held } = writableStore();
    const key = rsaKey(2048, "pkcs8");
    const file = path.join(directory, "key.pem");
    await fs.writeFile(file, key.pem);

    await handleSecretsPut("release-signing-key", {
      kind: "bundle-signing-key",
      file,
    });

    expect(held.get("release-signing-key")).toBe(key.pkcs8);
  });

  it.each([
    [
      "a key under 2048 bits",
      () => rsaKey(1024, "pkcs8").pem,
      "short.pem is a 1024-bit RSA key. Bundle signing needs 2048 bits or more.",
    ],
    [
      "a key other than RSA",
      () =>
        crypto
          .generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      "short.pem is not an RSA private key.",
    ],
    [
      "a public key",
      () =>
        crypto
          .generateKeyPairSync("rsa", { modulusLength: 2048 })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      "short.pem is not a private key in PEM.",
    ],
    [
      "an encrypted key",
      () =>
        crypto
          .generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({
            type: "pkcs8",
            format: "pem",
            cipher: "aes-256-cbc",
            passphrase: "pass",
          })
          .toString(),
      "short.pem is encrypted. Store the key without a passphrase.",
    ],
  ])("refuses %s, storing nothing", async (_, pem, message) => {
    const { store } = writableStore();
    const file = path.join(directory, "short.pem");
    await fs.writeFile(file, pem());

    await handleSecretsPut("bundle-signing-key", { file });

    expect(log.error).toHaveBeenCalledWith(message);
    expect(store.set).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses a store that doesn't read the key back", async () => {
    const { store } = writableStore();
    store.get.mockResolvedValue({ "bundle-signing-key": "another" });
    const file = path.join(directory, "key.pem");
    await fs.writeFile(file, rsaKey(2048, "pkcs8").pem);

    await handleSecretsPut("bundle-signing-key", { file });

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "spec-store doesn't read bundle-signing-key back as stored.",
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  it("asks for the PEM file, and takes no flags", async () => {
    writableStore();

    await handleSecretsPut("bundle-signing-key", {});
    await handleSecretsPut("bundle-signing-key", {
      file: "key.pem",
      p8: "AuthKey.p8",
    });

    expect(
      log.error.mock.calls.map(([text]) =>
        stripVTControlCharacters(String(text)),
      ),
    ).toEqual([
      expect.stringContaining(
        "npx hot-updater secrets put bundle-signing-key <key.pem>",
      ),
      "bundle-signing-key takes no --p8 <file>.\nIt takes only the PEM file.",
    ]);
  });
});

describe("hot-updater secrets put", () => {
  it("stores an App Store Connect key's files as one JSON value through the adapter, its key masked", async () => {
    // Given
    const { store, held } = writableStore();
    const p8 = path.join(directory, "AuthKey_PUTKEY1.p8");
    await fs.writeFile(p8, P8);

    // When
    await handleSecretsPut("asc-api-key", {
      kind: "asc-api-key",
      p8,
      keyId: "PUTKEY1",
      issuerId: "put-issuer",
    });

    // Then
    expect(process.exitCode).toBeUndefined();
    expect(store.set).toHaveBeenCalledWith(
      "asc-api-key",
      expect.any(String),
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    const value = held.get("asc-api-key")!;
    expect(JSON.parse(value)).toEqual({
      keyId: "PUTKEY1",
      issuerId: "put-issuer",
      p8: P8,
    });
    // The key and the whole value are masked; its IDs stay readable.
    const masked = maskSecretValues(`${value}\n${P8}`);
    expect(masked).not.toContain("putSpecKeyLine01");
    expect(masked).not.toContain(value);
    expect(maskSecretValues("key PUTKEY1 of put-issuer")).toBe(
      "key PUTKEY1 of put-issuer",
    );
    const [stored] = messages();
    expect(stored).toContain("Secret stored");
    expect(stored).toContain("spec://asc-api-key");
  });

  it("reads a keystore's passwords from the environment, never the command line, and stores the keystore in base64", async () => {
    const { held } = writableStore();
    const keystore = Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0x07]);
    const file = path.join(directory, "release.jks");
    await fs.writeFile(file, keystore);
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "put-store-password");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "put-key-password");

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore: file,
      keyAlias: "upload",
    });

    expect(JSON.parse(held.get("release-keystore")!)).toEqual({
      keystore: keystore.toString("base64"),
      storePassword: "put-store-password",
      keyAlias: "upload",
      keyPassword: "put-key-password",
    });
    expect(password).not.toHaveBeenCalled();
    // Checked as Gradle signs before it is stored.
    expect(jdkRuns.map(({ tool }) => tool)).toContain("jarsigner");
  });

  it("stores a service account's own JSON", async () => {
    const { held } = writableStore();
    const json = JSON.stringify({
      type: "service_account",
      client_email: "ci@example.com",
      private_key: "k",
    });
    const file = path.join(directory, "play.json");
    await fs.writeFile(file, json);

    await handleSecretsPut("release-play", {
      kind: "play-service-account",
      serviceAccount: file,
    });

    expect(held.get("release-play")).toBe(json);
  });

  it("refuses a file that is no service account JSON, storing nothing", async () => {
    const { store } = writableStore();
    const file = path.join(directory, "play.json");
    await fs.writeFile(file, "not json");

    await handleSecretsPut("release-play", {
      kind: "play-service-account",
      serviceAccount: file,
    });

    expect(log.error).toHaveBeenCalledWith("play.json is not a JSON key file.");
    expect(store.set).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses another kind's flags, storing nothing", async () => {
    const { store } = writableStore();

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore: "release.jks",
      keyAlias: "upload",
      p8: "AuthKey.p8",
    });

    expect(log.error).toHaveBeenCalledWith(
      "android-keystore takes no --p8 <file>.\nIt takes --keystore <file>, --key-alias <alias>.",
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses a name secret() can't name", async () => {
    const { store } = writableStore();

    await handleSecretsPut("../keys", {
      kind: "play-service-account",
      serviceAccount: "play.json",
    });

    expect(log.error).toHaveBeenCalledWith(
      '"../keys" is not a secret name.\nUse up to 64 letters, digits, ".", "_", "-"; start with a letter or digit.',
    );
    expect(store.set).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("stores in `localSecrets()`'s store without a secrets adapter, 0600, and names the file", async () => {
    configure();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    const json = JSON.stringify({
      type: "service_account",
      client_email: "ci@example.com",
      private_key: "k",
    });
    const file = path.join(directory, "play.json");
    await fs.writeFile(file, json);

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
      serviceAccount: file,
    });

    expect(process.exitCode).toBeUndefined();
    const stored = getLocalKeyFile("play-service-account", directory);
    expect(stored.startsWith(path.join(directory, "home", "secrets"))).toBe(
      true,
    );
    await expect(fs.readFile(stored, "utf-8")).resolves.toBe(json);
    expect((await fs.stat(stored)).mode & 0o777).toBe(0o600);
    // The file, which is outside the project, under ~ or shortened.
    expect(messages().at(-1)).toMatch(
      /\nSource {11}\S+play-service-account\.json$/u,
    );
    // Never a .env file.
    await expect(
      fs.access(path.join(directory, ".env.hotupdater")),
    ).rejects.toThrow();
  });

  it("refuses a value the environment overrides, which builds read first, before any prompt", async () => {
    configure();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      'HOT_UPDATER_RELEASE_KEYSTORE=\'{"keystore":"old"}\'\n',
    );

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore: "release.jks",
      keyAlias: "upload",
    });

    expect(log.error).toHaveBeenCalledWith(
      "The environment or .env.hotupdater overrides android-keystore.\nUnset HOT_UPDATER_RELEASE_KEYSTORE.",
    );
    expect(password).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  envSecrets,
  loadConfig,
  maskSecretValues,
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

// Only the config and the prompts are mocked.
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
// The GitHub Actions offer has its own specs: here it finds nothing to offer.
vi.mock("../utils/native/githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));
vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  // The Apple Account sign-in, which issues the key.
  issueAscApiKey: vi.fn(async (request: { name: string }) => ({
    p8: P8,
    keyId: "KEY1234567",
    issuerId: "issuer-1",
    name: request.name,
    team: {},
    revoke: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  })),
}));

const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49putSpecKeyLine01\n-----END PRIVATE KEY-----";

const messages = () =>
  log.message.mock.calls.map(([text]) =>
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

const configure = (secrets: SecretsAdapter, cacheDir?: string) => {
  vi.mocked(loadConfig).mockResolvedValue({ secrets, cacheDir } as never);
};

const withTTY = async <T>(isTTY: boolean, run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-secrets-"));
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
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
  });

  it("stores a service account's own JSON", async () => {
    const { held } = writableStore();
    const json = JSON.stringify({ client_email: "ci@example.com" });
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

    expect(log.error).toHaveBeenCalledWith(
      "--service-account is not a service account JSON key file.",
    );
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
      "A android-keystore takes --keystore <file>, --key-alias <alias>, not --p8 <file>.",
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses a name secret: references can't name", async () => {
    const { store } = writableStore();

    await handleSecretsPut("../keys", {
      kind: "play-service-account",
      serviceAccount: "play.json",
    });

    expect(log.error).toHaveBeenCalledWith(
      '"../keys" is no secret name: letters, digits, ".", "_", and "-", starting with a letter or a digit, up to 64 characters.',
    );
    expect(store.set).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("says where to put the value when the adapter is env(), which is read-only, before any prompt", async () => {
    configure(envSecrets());

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore: "release.jks",
      keyAlias: "upload",
    });

    expect(log.error).toHaveBeenCalledWith(
      "The env secrets adapter is read-only, so Hot Updater stores nothing in it. Set HOT_UPDATER_RELEASE_KEYSTORE in the environment or .env.hotupdater to the android-keystore as one JSON value, or set HOT_UPDATER_ANDROID_KEYSTORE_PATH or HOT_UPDATER_ANDROID_KEYSTORE_BASE64, HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, HOT_UPDATER_ANDROID_KEY_PASSWORD; or configure a secrets adapter that stores values.",
    );
    expect(password).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("hot-updater secrets put asc-api-key without a key", () => {
  it("keeps a stored key, without signing in", async () => {
    const { store } = writableStore({ "asc-api-key": "{}" });

    await withTTY(false, () =>
      handleSecretsPut("asc-api-key", { kind: "asc-api-key" }),
    );

    expect(process.exitCode).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
    const [stored] = messages();
    expect(stored).toContain("App Store Connect API key already stored");
    expect(stored).toContain("spec://asc-api-key");
  });

  it("refuses to sign in without a terminal, naming the command to run in one", async () => {
    const { store } = writableStore();

    await withTTY(false, () =>
      handleSecretsPut("asc-api-key", { kind: "asc-api-key" }),
    );

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Store it once from a terminal with `npx hot-updater secrets put asc-api-key --kind asc-api-key`",
      ),
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("signs in and writes the issued key to a 0600 file when the adapter is env(), which is read-only", async () => {
    configure(envSecrets(), directory);
    text.mockResolvedValue("dev@example.com");

    await withTTY(true, () =>
      handleSecretsPut("asc-api-key", { kind: "asc-api-key" }),
    );

    expect(process.exitCode).toBeUndefined();
    const file = path.join(directory, "issued", "asc-api-key.json");
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      keyId: "KEY1234567",
      p8: P8,
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const warned = stripVTControlCharacters(String(log.warn.mock.calls[0]![0]));
    expect(warned).toContain(file);
    expect(warned).toContain("HOT_UPDATER_ASC_API_KEY");
    expect(
      Object.values(log)
        .flatMap((fn) => fn.mock.calls.flat())
        .join("\n"),
    ).not.toContain("putSpecKeyLine01");
  });

  it("never signs in in CI", async () => {
    vi.stubEnv("CI", "true");
    const { store } = writableStore();

    await withTTY(true, () =>
      handleSecretsPut("asc-api-key", { kind: "asc-api-key" }),
    );

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("never in CI (CI is set)"),
    );
    expect(store.set).not.toHaveBeenCalled();
  });
});

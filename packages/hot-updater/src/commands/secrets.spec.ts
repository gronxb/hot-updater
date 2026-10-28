import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  p,
  getLocalKeyFile,
  loadConfig,
  maskSecretValues,
  withLocalKeyStore,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
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

/** Makes `secrets` the config's, as loadConfig hands it over: with `localSecrets()`'s store. */
const configure = (secrets?: SecretsAdapter) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: withLocalKeyStore(secrets),
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
      "android-keystore takes no --p8 <file>.\nIt takes --keystore <file>, --key-alias <alias>.",
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
      '"../keys" is not a secret name.\nUse up to 64 letters, digits, ".", "_", "-"; start with a letter or digit.',
    );
    expect(store.set).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("stores in `localSecrets()`'s store without a secrets adapter, 0600, and names the file", async () => {
    configure();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    const json = JSON.stringify({ type: "service_account", private_key: "k" });
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
      /\nSource {2}\S+play-service-account\.json$/u,
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

  it("refuses a value a read-only adapter already holds, which builds read first, before any prompt", async () => {
    configure({
      name: "read-only",
      get: async (names) =>
        Object.fromEntries(names.map((name) => [name, "held"])),
      describe: (name) => `ro://${name}`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await fs.writeFile(path.join(directory, "package.json"), "{}");

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore: "release.jks",
      keyAlias: "upload",
    });

    expect(log.error).toHaveBeenCalledWith(
      "release-keystore is in the read-only secrets adapter, which is read-only.\nReplace it there: ro://release-keystore",
    );
    expect(password).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("stores in `localSecrets()`'s store when the config's adapter stores nothing", async () => {
    configure({
      name: "read-only",
      get: async (names) =>
        Object.fromEntries(names.map((name) => [name, undefined])),
    });
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    const file = path.join(directory, "play.json");
    await fs.writeFile(file, '{"type":"service_account"}');

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
      serviceAccount: file,
    });

    expect(process.exitCode).toBeUndefined();
    await expect(
      fs.readFile(getLocalKeyFile("play-service-account", directory), "utf-8"),
    ).resolves.toBe('{"type":"service_account"}');
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});

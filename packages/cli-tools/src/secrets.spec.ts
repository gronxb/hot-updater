import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLocalKeyFile, writeLocalKey } from "./localKeyStore";
import {
  assertUnreservedEnv,
  isReservedVariableName,
} from "./reservedVariables";
import { maskSecretValues } from "./secretMasking";
import {
  describeStoredSecret,
  getConfiguredAdapter,
  getConfiguredSecrets,
  getLocalSecretsStore,
  localSecrets,
  parseSecretReference,
  readSecretWithSource,
  secretEnv,
  secretVariableName,
  setConfiguredSecrets,
  resolveSecretsAdapter,
} from "./secrets";

let directory: string;
let home: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-secrets-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-home-"));
  vi.stubEnv("HOT_UPDATER_HOME", home);
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  setConfiguredSecrets(resolveSecretsAdapter());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
  await fs.rm(home, { force: true, recursive: true });
});

const storeOf = (
  values: Readonly<Record<string, string>>,
): SecretsAdapter & { get: ReturnType<typeof vi.fn> } => ({
  name: "spec-store",
  set: async () => {},
  get: vi.fn(async (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  ),
  describe: (name) => `spec://${name}`,
});

describe("isReservedVariableName", () => {
  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "node_options",
    "PATH",
    "Path",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "GIT_SSH_COMMAND",
    "npm_config_registry",
    "NPM_CONFIG_USERCONFIG",
    "npm_CONFIG_x",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "GRADLE_OPTS",
    "RUBYOPT",
    "RUBYLIB",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PERL5OPT",
    "HOT_UPDATER_ASC_KEY_PATH",
    "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    "HOT_UPDATER_SIGNING_TOKEN",
    "HOT_UPDATER_HOME",
  ])("reserves %s", (name) => {
    expect(isReservedVariableName(name)).toBe(true);
  });

  it.each([
    "NODE_ENV",
    "CLOUDFLARE_API_TOKEN",
    "HOT_UPDATER_S3_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "PATHNAME",
    "ENVIRONMENT",
    "INFISICAL_TOKEN",
  ])("allows %s", (name) => {
    expect(isReservedVariableName(name)).toBe(false);
  });

  it("refuses a child environment that sets a reserved variable", () => {
    expect(() =>
      assertUnreservedEnv(
        { SAFE: "1", NODE_OPTIONS: "--require /tmp/x.js" },
        "The keystore",
      ),
    ).toThrow(
      "The keystore would set NODE_OPTIONS, which no secret may set: it changes how a process loads code or which credentials Hot Updater uses.",
    );
    expect(assertUnreservedEnv({ SAFE: "1" }, "The keystore")).toEqual({
      SAFE: "1",
    });
  });
});

describe("parseSecretReference", () => {
  it("reads the name of secret:<name>", () => {
    expect(
      parseSecretReference("secret:release-keystore", "signing.keystore"),
    ).toBe("release-keystore");
  });

  it.each([
    "vault:release-keystore",
    "release-keystore",
    "secret:",
    "secret:-x",
  ])("refuses %s", (reference) => {
    expect(() => parseSecretReference(reference, "signing.keystore")).toThrow(
      `signing.keystore names a secret as secret:<name>, such as "secret:release-keystore", and ${JSON.stringify(reference)} is not one.`,
    );
  });
});

describe("the default store", () => {
  it("maps a name to its variable", () => {
    expect(secretVariableName("CLOUDFLARE_API_TOKEN")).toBe(
      "CLOUDFLARE_API_TOKEN",
    );
    expect(secretVariableName("asc-api-key")).toBe("HOT_UPDATER_ASC_API_KEY");
    expect(secretVariableName("release.keystore")).toBe(
      "HOT_UPDATER_RELEASE_KEYSTORE",
    );
  });

  it("reads process.env, then .env.hotupdater, then `localSecrets()`'s store, and maps a missing name to undefined", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", '{"keyId":"K"}');
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      "FROM_FILE=file-value\nHOT_UPDATER_ASC_API_KEY=shadowed\n",
    );
    await writeLocalKey("asc-api-key", '{"keyId":"STORED"}', directory);
    await writeLocalKey("play-service-account", '{"type":"x"}', directory);

    const values = await resolveSecretsAdapter().get(
      ["asc-api-key", "FROM_FILE", "play-service-account", "MISSING_SPEC_VAR"],
      { cwd: directory },
    );

    expect({ ...values }).toEqual({
      "asc-api-key": '{"keyId":"K"}',
      FROM_FILE: "file-value",
      "play-service-account": '{"type":"x"}',
      MISSING_SPEC_VAR: undefined,
    });
  });

  it("stores in `localSecrets()`'s store under HOT_UPDATER_HOME, readable by this user alone", async () => {
    const secrets = resolveSecretsAdapter();

    await secrets.set!("asc-api-key", '{"keyId":"NEW"}', { cwd: directory });

    const file = getLocalKeyFile("asc-api-key", directory);
    expect(file.startsWith(path.join(home, "secrets") + path.sep)).toBe(true);
    expect(await fs.readFile(file, "utf-8")).toBe('{"keyId":"NEW"}');
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(home, "secrets"))).mode & 0o777).toBe(
        0o700,
      );
    }
    expect(
      (await secrets.get(["asc-api-key"], { cwd: directory }))["asc-api-key"],
    ).toBe('{"keyId":"NEW"}');
    expect(secrets.describe!("asc-api-key")).toBe(
      `HOT_UPDATER_ASC_API_KEY in the environment, or ${file} on this machine`,
    );
  });

  it("replaces a stored value whole, and keeps the file 0600", async () => {
    const secrets = resolveSecretsAdapter();
    await secrets.set!("asc-api-key", "first", { cwd: directory });
    const file = getLocalKeyFile("asc-api-key", directory);
    await fs.chmod(file, 0o644);

    await secrets.set!("asc-api-key", "second", { cwd: directory });

    expect(await fs.readFile(file, "utf-8")).toBe("second");
    expect(await fs.readdir(path.dirname(file))).toEqual(["asc-api-key.json"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("is the default until a config sets another, which is then the only store", async () => {
    expect(getConfiguredSecrets().name).toBe("localSecrets");
    const store = storeOf({ "asc-api-key": "from-store" });
    // Planted where localSecrets() keeps keys: a configured adapter never
    // reads them, so a teammate and this machine see the same store.
    await writeLocalKey("play-service-account", "from-machine", directory);
    await writeLocalKey("asc-api-key", "shadowed", directory);
    const secrets = resolveSecretsAdapter(store);

    expect(secrets).toBe(store);
    expect(getConfiguredAdapter(secrets)).toBe(store);
    expect(getLocalSecretsStore(secrets)).toBeUndefined();
    expect({
      ...(await secrets.get(["asc-api-key", "play-service-account"], {
        cwd: directory,
      })),
    }).toEqual({
      "asc-api-key": "from-store",
      "play-service-account": undefined,
    });
    expect(describeStoredSecret(secrets, "asc-api-key")).toBe(
      "spec://asc-api-key",
    );
  });

  it("stores through the config's adapter when it stores values", async () => {
    const set = vi.fn(async () => {});
    const secrets = resolveSecretsAdapter({ ...storeOf({}), set });

    await secrets.set!("asc-api-key", "value", { cwd: directory });

    expect(set).toHaveBeenCalledWith("asc-api-key", "value", {
      cwd: directory,
    });
    await expect(
      fs.access(getLocalKeyFile("asc-api-key", directory)),
    ).rejects.toThrow();
  });
});

describe("localSecrets()", () => {
  it("is the store a config without secrets gets, reading the environment, then its files", async () => {
    const secrets = localSecrets();
    await writeLocalKey("asc-api-key", "from-file", directory);

    expect(secrets.name).toBe("localSecrets");
    expect(getConfiguredAdapter(secrets)).toBeUndefined();
    expect(resolveSecretsAdapter(secrets)).toBe(secrets);
    await expect(
      secrets.get(["asc-api-key"], { cwd: directory }),
    ).resolves.toEqual({ "asc-api-key": "from-file" });
  });

  it("keeps the files in the directory path names, relative to the project", async () => {
    const secrets = localSecrets({ path: "../outside-secrets" });

    await secrets.set!("asc-api-key", "value", { cwd: directory });

    const file = path.resolve(directory, "../outside-secrets/asc-api-key.json");
    try {
      await expect(fs.readFile(file, "utf-8")).resolves.toBe("value");
      await expect(
        secrets.get(["asc-api-key"], { cwd: directory }),
      ).resolves.toEqual({ "asc-api-key": "value" });
      vi.spyOn(process, "cwd").mockReturnValue(directory);
      expect(secrets.describe!("asc-api-key")).toBe(
        `HOT_UPDATER_ASC_API_KEY in the environment, or ${file} on this machine`,
      );
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("readSecretWithSource", () => {
  it("names the one place localSecrets() read the value from: its variable, else its file", async () => {
    const secrets = localSecrets();
    await expect(
      readSecretWithSource(secrets, "asc-api-key", directory),
    ).resolves.toBeUndefined();

    await writeLocalKey("asc-api-key", "from-file", directory);
    await expect(
      readSecretWithSource(secrets, "asc-api-key", directory),
    ).resolves.toEqual({
      value: "from-file",
      source: getLocalKeyFile("asc-api-key", directory),
    });

    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", "from-env");
    await expect(
      readSecretWithSource(secrets, "asc-api-key", directory),
    ).resolves.toEqual({
      value: "from-env",
      source: "HOT_UPDATER_ASC_API_KEY (environment)",
    });
  });

  it("reads the config's adapter alone, never a file on this machine", async () => {
    const adapter = storeOf({ "asc-api-key": "from-adapter" });
    await writeLocalKey("asc-api-key", "from-file", directory);
    await writeLocalKey("play-service-account", "play-file", directory);
    const secrets = resolveSecretsAdapter(adapter);

    await expect(
      readSecretWithSource(secrets, "asc-api-key", directory),
    ).resolves.toEqual({ value: "from-adapter", source: "spec://asc-api-key" });
    await expect(
      readSecretWithSource(secrets, "play-service-account", directory),
    ).resolves.toBeUndefined();
    expect(adapter.get).toHaveBeenCalledTimes(2);
  });
});

describe("secretEnv", () => {
  it("reads the names the environment does not set from the configured adapter, in one get, never into process.env", async () => {
    // Given
    vi.stubEnv("SPEC_FROM_ENV", "env-value");
    vi.stubEnv("SPEC_FROM_STORE", undefined);
    const store = storeOf({ SPEC_FROM_STORE: "store-value-secret" });
    setConfiguredSecrets(store);
    const before = { ...process.env };

    // When
    const values = await secretEnv(["SPEC_FROM_ENV", "SPEC_FROM_STORE"])();

    // Then
    expect({ ...values }).toEqual({
      SPEC_FROM_ENV: "env-value",
      SPEC_FROM_STORE: "store-value-secret",
    });
    expect(Object.isFrozen(values)).toBe(true);
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.get).toHaveBeenCalledWith(["SPEC_FROM_STORE"], {
      cwd: directory,
    });
    expect(process.env).toEqual(before);
    expect(maskSecretValues("token store-value-secret")).not.toContain(
      "store-value-secret",
    );
  });

  it("reads the adapter once for every adapter that calls it, and again after a failure", async () => {
    vi.stubEnv("SPEC_SHARED", undefined);
    const store = storeOf({ SPEC_SHARED: "shared-value" });
    store.get.mockRejectedValueOnce(new Error("store unreachable"));
    setConfiguredSecrets(store);
    const deploy = secretEnv(["SPEC_SHARED"]);

    await expect(deploy()).rejects.toThrow("store unreachable");
    const [storage, database] = await Promise.all([deploy(), deploy()]);

    expect(storage).toBe(database);
    expect(storage.SPEC_SHARED).toBe("shared-value");
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it("reads nothing until it is called", () => {
    const store = storeOf({});
    setConfiguredSecrets(store);

    secretEnv(["SPEC_LAZY"]);

    expect(store.get).not.toHaveBeenCalled();
  });

  it("names what the adapter does not hold", async () => {
    vi.stubEnv("SPEC_MISSING", undefined);
    setConfiguredSecrets(storeOf({}));

    await expect(secretEnv(["SPEC_MISSING"])()).rejects.toThrow(
      "secretEnv found no value for SPEC_MISSING: it is not set in the environment or .env.hotupdater, and the spec-store secrets adapter does not hold it (spec://SPEC_MISSING).",
    );
  });

  it("reads deploy credentials from the environment alone without a configured adapter, never from `localSecrets()`'s store", async () => {
    vi.stubEnv("SPEC_MISSING", undefined);
    await writeLocalKey("SPEC_MISSING", "machine-value", directory);

    await expect(secretEnv(["SPEC_MISSING"])()).rejects.toThrow(
      "secretEnv found no value for SPEC_MISSING: set it in the environment or .env.hotupdater, or read it from a secrets store with the config's secrets.",
    );
  });

  it("refuses reserved and invalid names when the config loads", () => {
    expect(() => secretEnv(["NODE_OPTIONS", "CLOUDFLARE_API_TOKEN"])).toThrow(
      "secretEnv refuses NODE_OPTIONS: it changes how a process loads code or which credentials Hot Updater uses.",
    );
    expect(() => secretEnv(["npm_config_registry", "LD_PRELOAD"])).toThrow(
      "secretEnv refuses npm_config_registry and LD_PRELOAD",
    );
    expect(() => secretEnv(["asc-api-key"])).toThrow(
      'secretEnv takes environment variable names: letters, digits, and underscores, not starting with a digit, and "asc-api-key" is not.',
    );
  });
});

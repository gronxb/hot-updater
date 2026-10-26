import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertUnreservedEnv,
  isReservedVariableName,
} from "./reservedVariables";
import { maskSecretValues } from "./secretMasking";
import {
  envSecrets,
  getConfiguredSecrets,
  parseSecretReference,
  secretEnv,
  secretVariableName,
  setConfiguredSecrets,
} from "./secrets";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-secrets-"));
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  setConfiguredSecrets(envSecrets());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

const storeOf = (
  values: Readonly<Record<string, string>>,
): SecretsAdapter & { get: ReturnType<typeof vi.fn> } => ({
  name: "spec-store",
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
    "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
    "INFISICAL_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
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

describe("envSecrets()", () => {
  it("maps a name to its variable", () => {
    expect(secretVariableName("CLOUDFLARE_API_TOKEN")).toBe(
      "CLOUDFLARE_API_TOKEN",
    );
    expect(secretVariableName("asc-api-key")).toBe("HOT_UPDATER_ASC_API_KEY");
    expect(secretVariableName("release.keystore")).toBe(
      "HOT_UPDATER_RELEASE_KEYSTORE",
    );
  });

  it("reads process.env, then .env.hotupdater, and maps a missing name to undefined", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", '{"keyId":"K"}');
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      "FROM_FILE=file-value\nHOT_UPDATER_ASC_API_KEY=shadowed\n",
    );

    const values = await envSecrets().get(
      ["asc-api-key", "FROM_FILE", "MISSING_SPEC_VAR"],
      { cwd: directory },
    );

    expect(values).toEqual({
      "asc-api-key": '{"keyId":"K"}',
      FROM_FILE: "file-value",
      MISSING_SPEC_VAR: undefined,
    });
  });

  it("is read-only and the default until a config sets another", () => {
    expect(envSecrets().set).toBeUndefined();
    expect(getConfiguredSecrets().name).toBe("envSecrets");
    const store = storeOf({});
    setConfiguredSecrets(store);
    expect(getConfiguredSecrets()).toBe(store);
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

  it("tells envSecrets() users where to set a missing name", async () => {
    vi.stubEnv("SPEC_MISSING", undefined);

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

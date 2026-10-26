import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialUnavailableError,
  createCredentialResolver,
  withCredentialResolver,
} from "./credentialResolver";
import { maskSecretValues } from "./secretMasking";
import { envSecrets, setConfiguredSecrets } from "./secrets";

/** A secrets adapter holding `values`, whose `get` records each call. */
const fakeSecrets = (
  values: Readonly<Record<string, string>>,
): SecretsAdapter & { get: ReturnType<typeof vi.fn> } => ({
  name: "fake",
  get: vi.fn(async (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  ),
  describe: (name) => `fake://${name}`,
});

const P8_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgresolverSpecKey01",
  "oAoGCCqGSM49AwEHoUQDQgAEresolverSpecKeyLine02resolverSpecKeyLine",
  "-----END PRIVATE KEY-----",
].join("\n");

const exists = (filePath: string) =>
  fs.access(filePath).then(
    () => true,
    () => false,
  );

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-credential-resolver-"),
  );
  // The project whose .env.hotupdater envSecrets() reads.
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  setConfiguredSecrets(envSecrets());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("createCredentialResolver", () => {
  it("uses the environment override and never reads the secrets adapter", async () => {
    // Given
    const keyPath = path.join(directory, "AuthKey_ABC123.p8");
    await fs.writeFile(keyPath, P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_PATH", keyPath);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const secrets = fakeSecrets({});
    const resolver = createCredentialResolver({ secrets });

    // When
    const credential = await resolver.resolve({ kind: "asc-api-key" });

    // Then
    expect(credential).toEqual({
      keyPath,
      keyId: "ABC123",
      issuerId: "issuer-1",
    });
    expect(secrets.get).not.toHaveBeenCalled();
    await resolver.dispose();
  });

  it("reads overrides from the given env after process.env", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "FROM_PROCESS");
    const resolver = createCredentialResolver({
      env: {
        HOT_UPDATER_ASC_KEY: P8_KEY,
        HOT_UPDATER_ASC_KEY_ID: "FROM_FILE",
        HOT_UPDATER_ASC_ISSUER_ID: "issuer-1",
      },
    });

    const credential = await resolver.resolve({ kind: "asc-api-key" });

    expect(credential.keyId).toBe("FROM_PROCESS");
    await resolver.dispose();
  });

  it("resolves a secret: name as one JSON value from the config's adapter", async () => {
    // Given: the config's adapter, as loadConfig registers it
    const keystore = Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0x01]);
    const secrets = fakeSecrets({
      "release-keystore": JSON.stringify({
        keystore: keystore.toString("base64"),
        storePassword: "json-store-password",
        keyAlias: "json-alias",
        keyPassword: "json-key-password",
      }),
    });
    setConfiguredSecrets(secrets);
    const before = { ...process.env };

    // When
    await withCredentialResolver(async (resolver) => {
      const credential = await resolver.resolve({
        kind: "android-keystore",
        name: "release-keystore",
      });

      // Then: the files hold the values, and process.env none of them
      expect(path.basename(credential.storeFile)).toBe(
        "release-keystore.keystore",
      );
      expect(await fs.readFile(credential.storeFile)).toEqual(keystore);
      expect((await fs.stat(credential.storeFile)).mode & 0o777).toBe(0o600);
      expect(credential).toMatchObject({
        storePassword: "json-store-password",
        keyAlias: "json-alias",
        keyPassword: "json-key-password",
      });
    });
    expect(secrets.get).toHaveBeenCalledWith(["release-keystore"], {
      cwd: directory,
    });
    expect(process.env).toEqual(before);
  });

  it("maps an App Store Connect key's JSON fields, p8 as the PEM", async () => {
    const secrets = fakeSecrets({
      "asc-api-key": JSON.stringify({
        keyId: "JSONKEY1",
        issuerId: "json-issuer",
        p8: P8_KEY,
      }),
    });

    await withCredentialResolver(
      async (resolver) => {
        const { keyPath, keyId, issuerId } = await resolver.resolve({
          kind: "asc-api-key",
        });

        expect([keyId, issuerId]).toEqual(["JSONKEY1", "json-issuer"]);
        expect(path.basename(keyPath)).toBe("AuthKey_JSONKEY1.p8");
        expect(await fs.readFile(keyPath, "utf-8")).toBe(P8_KEY);
      },
      { secrets },
    );
  });

  it("takes a service account's own JSON as it is", async () => {
    const json = JSON.stringify({ client_email: "ci@example.com" });
    const resolver = createCredentialResolver({
      secrets: fakeSecrets({ "release-play": json }),
    });

    const credential = await resolver.resolve({
      kind: "play-service-account",
      name: "release-play",
    });

    expect(credential).toEqual({ json });
    await resolver.dispose();
  });

  it("reads the items asked for together in one get", async () => {
    const secrets = fakeSecrets({
      "asc-api-key": JSON.stringify({
        keyId: "BATCH1",
        issuerId: "issuer-1",
        p8: P8_KEY,
      }),
      "play-service-account": "{}",
    });

    await withCredentialResolver(
      async (resolver) => {
        await Promise.all([
          resolver.resolve({ kind: "asc-api-key" }),
          resolver.resolve({ kind: "play-service-account" }),
        ]);
      },
      { secrets },
    );

    expect(secrets.get).toHaveBeenCalledTimes(1);
    expect(secrets.get).toHaveBeenCalledWith(
      ["asc-api-key", "play-service-account"],
      { cwd: directory },
    );
  });

  it("reads the adapter a getter returns when an item resolves, not when the resolver is made", async () => {
    let current: SecretsAdapter | undefined;
    const resolver = createCredentialResolver({ secrets: () => current! });
    current = fakeSecrets({ "play-service-account": "{}" });

    await expect(
      resolver.resolve({ kind: "play-service-account" }),
    ).resolves.toEqual({ json: "{}" });
    await resolver.dispose();
  });

  it("resolves one item once", async () => {
    const secrets = fakeSecrets({ "play-service-account": "{}" });
    const resolver = createCredentialResolver({ secrets });

    await resolver.resolve({ kind: "play-service-account" });
    await resolver.resolve({ kind: "play-service-account" });

    expect(secrets.get).toHaveBeenCalledTimes(1);
    await resolver.dispose();
  });

  it("fails naming the adapter, the command that stores it, and every replacement env var when nothing provides the item", async () => {
    const resolver = createCredentialResolver({ secrets: fakeSecrets({}) });

    const error = await resolver
      .resolve({ kind: "asc-api-key" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialUnavailableError);
    expect((error as Error).message).toBe(
      "asc-api-key is not in the fake secrets adapter (fake://asc-api-key). Store it once with `npx hot-updater apple login`. Or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key from the environment.",
    );
    expect((error as CredentialUnavailableError).envNames).toEqual([
      "HOT_UPDATER_ASC_KEY_PATH",
      "HOT_UPDATER_ASC_KEY",
      "HOT_UPDATER_ASC_KEY_ID",
      "HOT_UPDATER_ASC_ISSUER_ID",
    ]);
  });

  it("names the full secrets issue form for a custom name, which the shortcut does not take", async () => {
    const resolver = createCredentialResolver({ secrets: fakeSecrets({}) });

    await expect(
      resolver.resolve({ kind: "play-service-account", name: "widget-play" }),
    ).rejects.toThrow(
      "widget-play (play-service-account) is not in the fake secrets adapter (fake://widget-play). Store it once with `npx hot-updater secrets issue play-service-account widget-play`.",
    );
  });

  it("names envSecrets()'s JSON variable when the environment holds nothing", async () => {
    await expect(
      createCredentialResolver().resolve({
        kind: "android-keystore",
        name: "release-keystore",
      }),
    ).rejects.toThrow(
      "release-keystore (android-keystore) is not in the envSecrets secrets adapter (HOT_UPDATER_RELEASE_KEYSTORE in the environment or .env.hotupdater).",
    );
  });

  it("adds the replacement env vars to the adapter's failure", async () => {
    const reason = new Error("AccessDenied: secretsmanager:GetSecretValue");
    const resolver = createCredentialResolver({
      secrets: {
        name: "aws",
        get: async () => {
          throw reason;
        },
      },
    });

    const error = await resolver
      .resolve({ kind: "android-keystore" })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "The aws secrets adapter could not read android-keystore: AccessDenied: secretsmanager:GetSecretValue Or set HOT_UPDATER_ANDROID_KEYSTORE_PATH (or HOT_UPDATER_ANDROID_KEYSTORE_BASE64), HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, and HOT_UPDATER_ANDROID_KEY_PASSWORD to provide android-keystore from the environment.",
    );
    expect((error as Error).cause).toBe(reason);
  });

  it("fails naming the JSON shape a value lacks", async () => {
    const resolver = createCredentialResolver({
      secrets: fakeSecrets({
        "asc-api-key": JSON.stringify({ keyId: "K", p8: "x" }),
        "android-keystore": "not json",
      }),
    });

    await expect(resolver.resolve({ kind: "asc-api-key" })).rejects.toThrow(
      'The fake secrets adapter\'s asc-api-key has no issuerId: an asc-api-key is one JSON value, {"keyId", "issuerId", "p8"}.',
    );
    await expect(
      resolver.resolve({ kind: "android-keystore" }),
    ).rejects.toThrow(
      'The fake secrets adapter\'s android-keystore is not a JSON object: an android-keystore is one JSON value, {"keystore", "storePassword", "keyAlias", "keyPassword"}.',
    );
    await resolver.dispose();
  });

  it("fails on a partial override instead of reading the adapter", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    const secrets = fakeSecrets({});
    const resolver = createCredentialResolver({ secrets });

    await expect(resolver.resolve({ kind: "asc-api-key" })).rejects.toThrow(
      "The environment overrides asc-api-key but HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY) and HOT_UPDATER_ASC_ISSUER_ID are not set.",
    );
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("fails when an override path cannot be read", async () => {
    const missing = path.join(directory, "missing.p8");
    vi.stubEnv("HOT_UPDATER_ASC_KEY_PATH", missing);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");

    await expect(
      createCredentialResolver().resolve({ kind: "asc-api-key" }),
    ).rejects.toThrow(
      "HOT_UPDATER_ASC_KEY_PATH does not point to a readable file.",
    );
  });

  it("fails when an override path is not a file", async () => {
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH", directory);

    await expect(
      createCredentialResolver().resolve({ kind: "play-service-account" }),
    ).rejects.toThrow(
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH does not point to a readable file.",
    );
  });

  it("rejects a service account that is not a JSON object", async () => {
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON", "not json");

    await expect(
      createCredentialResolver().resolve({ kind: "play-service-account" }),
    ).rejects.toThrow(
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON is not a service account JSON object.",
    );
  });

  it("keeps passwords as set", async () => {
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_BASE64", "a2V5c3RvcmU=");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", " store pass ");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", " release ");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-pass ");
    const resolver = createCredentialResolver();

    const credential = await resolver.resolve({ kind: "android-keystore" });

    expect(credential.storePassword).toBe(" store pass ");
    expect(credential.keyPassword).toBe("key-pass ");
    expect(credential.keyAlias).toBe("release");
    await resolver.dispose();
  });
});

describe("credential temporary files", () => {
  it("writes file contents as a 0600 file and deletes it on dispose", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const resolver = createCredentialResolver();

    const { keyPath } = await resolver.resolve({ kind: "asc-api-key" });

    expect(path.basename(keyPath)).toBe("AuthKey_ABC123.p8");
    expect(keyPath.startsWith(os.tmpdir())).toBe(true);
    expect(await fs.readFile(keyPath, "utf-8")).toBe(P8_KEY);
    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);

    await resolver.dispose();

    expect(await exists(keyPath)).toBe(false);
  });

  it("restores the newlines of a key pasted on one line", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY.replaceAll("\n", "\\n"));
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");

    await withCredentialResolver(async (resolver) => {
      const { keyPath } = await resolver.resolve({ kind: "asc-api-key" });

      expect(await fs.readFile(keyPath, "utf-8")).toBe(P8_KEY);
    });
  });

  it("rejects a keystore that is not base64", async () => {
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_BASE64", "not base64!");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "store-password");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", "release");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-password");

    await expect(
      createCredentialResolver().resolve({ kind: "android-keystore" }),
    ).rejects.toThrow(
      "HOT_UPDATER_ANDROID_KEYSTORE_BASE64 is not a base64-encoded keystore.",
    );
  });

  it("writes a base64 keystore as binary", async () => {
    const keystore = Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0x00, 0x02]);
    vi.stubEnv(
      "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
      keystore.toString("base64"),
    );
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "store-password");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", "release");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-password");

    await withCredentialResolver(async (resolver) => {
      const { storeFile } = await resolver.resolve({
        kind: "android-keystore",
        name: "release-keystore",
      });

      expect(path.basename(storeFile)).toBe("release-keystore.keystore");
      expect(await fs.readFile(storeFile)).toEqual(keystore);
      expect((await fs.stat(storeFile)).mode & 0o777).toBe(0o600);
    });
  });

  it("waits for a resolution in flight before deleting the files", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = createCredentialResolver({
      secrets: {
        name: "late",
        get: async () => {
          await released;
          return {
            "asc-api-key": JSON.stringify({
              keyId: "LATE",
              issuerId: "issuer-1",
              p8: P8_KEY,
            }),
          };
        },
      },
    });

    const resolving = resolver.resolve({ kind: "asc-api-key" });
    const disposing = resolver.dispose();
    release();
    const { keyPath } = await resolving;
    await disposing;

    expect(keyPath).not.toBe("");
    expect(await exists(keyPath)).toBe(false);
    await expect(resolver.resolve({ kind: "asc-api-key" })).rejects.toThrow(
      "The credential resolver has been disposed.",
    );
  });

  it("makes every concurrent dispose wait for the deletion", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const resolver = createCredentialResolver();
    const { keyPath } = await resolver.resolve({ kind: "asc-api-key" });

    const first = resolver.dispose();
    await resolver.dispose();

    expect(await exists(keyPath)).toBe(false);
    await first;
  });

  it("deletes the files in finally when the command fails", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    let keyPath = "";

    await expect(
      withCredentialResolver(async (resolver) => {
        ({ keyPath } = await resolver.resolve({ kind: "asc-api-key" }));
        throw new Error("xcodebuild failed");
      }),
    ).rejects.toThrow("xcodebuild failed");

    expect(keyPath).not.toBe("");
    expect(await exists(keyPath)).toBe(false);
  });

  const resolveInFreshModule = async () => {
    vi.resetModules();
    const onSpy = vi.spyOn(process, "on");
    const { createCredentialResolver: createFreshResolver } =
      await import("./credentialResolver");
    const resolver = createFreshResolver({
      secrets: fakeSecrets({
        "asc-api-key": JSON.stringify({
          keyId: "EXIT",
          issuerId: "issuer-1",
          p8: P8_KEY,
        }),
      }),
    });
    const { keyPath } = await resolver.resolve({ kind: "asc-api-key" });
    const listenerOf = (event: string) =>
      onSpy.mock.calls.find(([name]) => name === event)?.[1] as (
        signal?: NodeJS.Signals,
      ) => void;
    return { keyPath, listenerOf, resolver };
  };

  it("deletes the files on process exit", async () => {
    const { keyPath, listenerOf } = await resolveInFreshModule();
    const exitListener = listenerOf("exit");

    expect(exitListener).toBeTypeOf("function");
    expect(await exists(keyPath)).toBe(true);
    exitListener();
    expect(await exists(keyPath)).toBe(false);
  });

  it("deletes the files on a termination signal and re-raises it", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(0);
    const { keyPath, listenerOf } = await resolveInFreshModule();

    listenerOf("SIGTERM")("SIGTERM");

    expect(await exists(keyPath)).toBe(false);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("leaves the signal to another listener that handles it", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(1);
    const { keyPath, listenerOf } = await resolveInFreshModule();

    listenerOf("SIGINT")("SIGINT");

    expect(await exists(keyPath)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops listening once every file is deleted", async () => {
    const { listenerOf, resolver } = await resolveInFreshModule();
    const exitListener = listenerOf("exit");

    expect(process.listeners("exit")).toContain(exitListener);
    await resolver.dispose();
    expect(process.listeners("exit")).not.toContain(exitListener);
    expect(process.listeners("SIGINT")).not.toContain(listenerOf("SIGINT"));
  });
});

describe("credential masking", () => {
  it("masks resolved secrets and leaves identifiers readable", async () => {
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_BASE64", "a2V5c3RvcmUtYnl0ZXM=");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "mask-store-secret");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", "release-alias");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "mask-key-secret");
    vi.stubEnv(
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
      JSON.stringify({
        client_email: "ci@example.com",
        private_key: "mask-play-private-key",
      }),
    );
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "MASKKEYID");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");

    await withCredentialResolver(async (resolver) => {
      await resolver.resolve({ kind: "android-keystore" });
      await resolver.resolve({ kind: "play-service-account" });
      await resolver.resolve({ kind: "asc-api-key" });
    });

    const masked = maskSecretValues(
      [
        "-Pandroid.injected.signing.store.password=mask-store-secret",
        "-Pandroid.injected.signing.key.password=mask-key-secret",
        "keystore a2V5c3RvcmUtYnl0ZXM=",
        "key mask-play-private-key",
        P8_KEY.split("\n")[1],
        "alias release-alias, key MASKKEYID",
      ].join("\n"),
    );

    expect(masked).not.toContain("mask-store-secret");
    expect(masked).not.toContain("mask-key-secret");
    expect(masked).not.toContain("a2V5c3RvcmUtYnl0ZXM=");
    expect(masked).not.toContain("mask-play-private-key");
    expect(masked).not.toContain(P8_KEY.split("\n")[1]);
    expect(masked).toContain("alias release-alias, key MASKKEYID");
  });

  it("masks every secret field of a JSON credential the adapter holds, and leaves its identifiers readable", async () => {
    // Given: a keystore and a service account as one JSON value each
    const keystore = {
      keystore: Buffer.from("json-masked-keystore").toString("base64"),
      storePassword: "json-mask-store",
      keyAlias: "release",
      keyPassword: "json-mask-key",
    };
    const serviceAccount = {
      type: "service_account",
      client_email: "json-mask@project.iam.gserviceaccount.com",
      private_key: "json-mask-private-key",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const secrets = fakeSecrets({
      "android-keystore": JSON.stringify(keystore),
      "play-service-account": JSON.stringify(serviceAccount),
    });

    // When
    await withCredentialResolver(
      async (resolver) => {
        await resolver.resolve({ kind: "android-keystore" });
        await resolver.resolve({ kind: "play-service-account" });
      },
      { secrets },
    );

    // Then: no secret field prints, nor the whole value
    const masked = maskSecretValues(
      [
        keystore.keystore,
        keystore.storePassword,
        keystore.keyPassword,
        serviceAccount.private_key,
        JSON.stringify(keystore),
      ].join("\n"),
    );
    for (const value of [
      keystore.keystore,
      keystore.storePassword,
      keystore.keyPassword,
      serviceAccount.private_key,
      JSON.stringify(keystore),
    ]) {
      expect(masked).not.toContain(value);
    }
    // The alias, the service account's email, and its endpoints stay
    // readable: an alias such as release would mask every scheme name.
    expect(
      maskSecretValues(
        `Built the release scheme with ${serviceAccount.client_email} at https://oauth2.googleapis.com/token`,
      ),
    ).toBe(
      `Built the release scheme with ${serviceAccount.client_email} at https://oauth2.googleapis.com/token`,
    );
  });
});

describe("envSecrets() as the secrets adapter", () => {
  it("reads a credential's JSON value from its variable", async () => {
    vi.stubEnv(
      "HOT_UPDATER_ASC_API_KEY",
      JSON.stringify({ keyId: "ENVJSON1", issuerId: "issuer-1", p8: P8_KEY }),
    );

    await withCredentialResolver(async (resolver) => {
      const { keyId, keyPath } = await resolver.resolve({
        kind: "asc-api-key",
      });

      expect(keyId).toBe("ENVJSON1");
      expect(await fs.readFile(keyPath, "utf-8")).toBe(P8_KEY);
    });
  });

  it("reads the JSON value from .env.hotupdater", async () => {
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      `HOT_UPDATER_RELEASE_PLAY='${JSON.stringify({ client_email: "file@example.com" })}'\n`,
    );

    const credential = await withCredentialResolver((resolver) =>
      resolver.resolve({ kind: "play-service-account", name: "release-play" }),
    );

    expect(JSON.parse(credential.json)).toEqual({
      client_email: "file@example.com",
    });
  });

  it("prefers the per-field variables over the JSON value", async () => {
    vi.stubEnv(
      "HOT_UPDATER_ASC_API_KEY",
      JSON.stringify({ keyId: "FROMJSON", issuerId: "issuer-1", p8: P8_KEY }),
    );
    vi.stubEnv("HOT_UPDATER_ASC_KEY", P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "FROMFIELDS");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");

    const { keyId } = await withCredentialResolver((resolver) =>
      resolver.resolve({ kind: "asc-api-key" }),
    );

    expect(keyId).toBe("FROMFIELDS");
  });
});

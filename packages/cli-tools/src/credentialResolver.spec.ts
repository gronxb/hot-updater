import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CredentialSource,
  CredentialUnavailableError,
  createCredentialResolver,
  withCredentialResolver,
} from "./credentialResolver";
import { maskSecretValues } from "./secretMasking";

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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("createCredentialResolver", () => {
  it("uses the environment override and never calls the source", async () => {
    // Given
    const keyPath = path.join(directory, "AuthKey_ABC123.p8");
    await fs.writeFile(keyPath, P8_KEY);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_PATH", keyPath);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const source = vi.fn<CredentialSource>();
    const resolver = createCredentialResolver({ source });

    // When
    const credential = await resolver.resolve({ kind: "asc-api-key" });

    // Then
    expect(credential).toEqual({
      keyPath,
      keyId: "ABC123",
      issuerId: "issuer-1",
    });
    expect(source).not.toHaveBeenCalled();
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

  it("calls the source when no override is set", async () => {
    const source = vi.fn<CredentialSource>(async (_request, { files }) => ({
      kind: "play-service-account",
      credential: {
        json: await fs.readFile(
          await files.write("play.json", '{"client_email":"ci@example.com"}'),
          "utf-8",
        ),
      },
    }));
    const resolver = createCredentialResolver({ source });

    const credential = await resolver.resolve({
      kind: "play-service-account",
      name: "release-play",
    });

    expect(credential).toEqual({ json: '{"client_email":"ci@example.com"}' });
    expect(source).toHaveBeenCalledWith(
      { kind: "play-service-account", name: "release-play" },
      expect.objectContaining({ files: expect.anything() }),
    );
    await resolver.dispose();
  });

  it("resolves one item once", async () => {
    const source = vi.fn<CredentialSource>(async () => ({
      kind: "play-service-account",
      credential: { json: "{}" },
    }));
    const resolver = createCredentialResolver({ source });

    await resolver.resolve({ kind: "play-service-account" });
    await resolver.resolve({ kind: "play-service-account" });

    expect(source).toHaveBeenCalledTimes(1);
    await resolver.dispose();
  });

  it("fails naming every replacement env var when nothing provides the item", async () => {
    const resolver = createCredentialResolver();

    const error = await resolver
      .resolve({ kind: "asc-api-key" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialUnavailableError);
    expect((error as Error).message).toBe(
      "No asc-api-key credential is configured. Set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID.",
    );
    expect((error as CredentialUnavailableError).envNames).toEqual([
      "HOT_UPDATER_ASC_KEY_PATH",
      "HOT_UPDATER_ASC_KEY",
      "HOT_UPDATER_ASC_KEY_ID",
      "HOT_UPDATER_ASC_ISSUER_ID",
    ]);
  });

  it("adds the replacement env vars to the source's failure", async () => {
    const reason = new Error(
      "Cannot reach the Console at https://console.example.com.",
    );
    const resolver = createCredentialResolver({
      source: async () => {
        throw reason;
      },
    });

    const error = await resolver
      .resolve({ kind: "android-keystore" })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "Cannot reach the Console at https://console.example.com. Set HOT_UPDATER_ANDROID_KEYSTORE_PATH (or HOT_UPDATER_ANDROID_KEYSTORE_BASE64), HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, and HOT_UPDATER_ANDROID_KEY_PASSWORD to provide android-keystore without the vault.",
    );
    expect((error as Error).cause).toBe(reason);
  });

  it("fails when the source returns another kind", async () => {
    const resolver = createCredentialResolver({
      source: async () => ({
        kind: "play-service-account",
        credential: { json: "{}" },
      }),
    });

    await expect(
      resolver.resolve({ kind: "android-keystore" }),
    ).rejects.toThrow(
      "The credential source returned no valid android-keystore. Set HOT_UPDATER_ANDROID_KEYSTORE_PATH",
    );
  });

  it("fails on a partial override instead of calling the source", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    const source = vi.fn<CredentialSource>();
    const resolver = createCredentialResolver({ source });

    await expect(resolver.resolve({ kind: "asc-api-key" })).rejects.toThrow(
      "The environment overrides asc-api-key but HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY) and HOT_UPDATER_ASC_ISSUER_ID are not set.",
    );
    expect(source).not.toHaveBeenCalled();
  });

  it("fails when an override path cannot be read", async () => {
    const missing = path.join(directory, "missing.p8");
    vi.stubEnv("HOT_UPDATER_ASC_KEY_PATH", missing);
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ABC123");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");

    await expect(
      createCredentialResolver().resolve({ kind: "asc-api-key" }),
    ).rejects.toThrow(
      `HOT_UPDATER_ASC_KEY_PATH points to ${missing}, which cannot be read.`,
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
    const source: CredentialSource = async (_request, { files }) => ({
      kind: "asc-api-key",
      credential: {
        keyPath: await files.write("AuthKey_EXIT.p8", P8_KEY),
        keyId: "EXIT",
        issuerId: "issuer-1",
      },
    });
    const resolver = createFreshResolver({ source });
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
});

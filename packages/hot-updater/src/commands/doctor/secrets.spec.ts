import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type ConfigResponse,
  localSecrets,
  writeLocalKey,
} from "@hot-updater/cli-tools";
import { secret } from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  androidKeystoreValue,
  findKeytool,
} from "../../utils/native/androidKeystore";
import { checkSecrets } from "./secrets";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(cwd, "home"));
  for (const name of [
    "HOT_UPDATER_ASC_KEY_PATH",
    "HOT_UPDATER_ASC_KEY",
    "HOT_UPDATER_ASC_KEY_ID",
    "HOT_UPDATER_ASC_ISSUER_ID",
    "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
    "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
    "HOT_UPDATER_BUNDLE_SIGNING_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(cwd, { recursive: true, force: true });
});

const configWith = (secrets: SecretsAdapter) =>
  ({
    secrets,
    nativeBuild: {
      ios: {
        release: { signing: { ascApiKey: secret("asc-api-key") } },
        staging: { signing: { ascApiKey: secret("asc-api-key") } },
      },
      android: {
        release: { signing: { keystore: secret("release-keystore") } },
      },
    },
    signing: { enabled: true, privateKey: secret("bundle-signing-key") },
  }) as unknown as ConfigResponse;

const teamStore = (values: Record<string, string>) => ({
  name: "team-store",
  set: async () => {},
  get: vi.fn(async (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  ),
});

describe("checkSecrets", () => {
  it("says where each build credential's secret() is read from, with one get and no local fallback", async () => {
    const store = teamStore({ "asc-api-key": "{}" });
    // Planted where localSecrets() keeps keys: never read under an adapter.
    await writeLocalKey("bundle-signing-key", "pem", cwd);
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PATH", "/tmp/release.jks");

    const status = await checkSecrets(configWith(store), cwd);

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.get).toHaveBeenCalledWith(
      ["asc-api-key", "release-keystore", "bundle-signing-key"],
      { cwd },
    );
    expect(status).toEqual({
      adapter: "team-store",
      references: [
        {
          name: "asc-api-key",
          fields: [
            "nativeBuild.ios.release.signing.ascApiKey",
            "nativeBuild.ios.staging.signing.ascApiKey",
          ],
          source: "adapter",
          inAdapter: true,
        },
        {
          name: "release-keystore",
          fields: ["nativeBuild.android.release.signing.keystore"],
          source: "environment",
          inAdapter: false,
        },
        {
          name: "bundle-signing-key",
          fields: ["signing.privateKey"],
          source: "missing",
          inAdapter: false,
        },
      ],
    });
  });

  it("names the shorthand's secret as signing's", async () => {
    const store = teamStore({ "bundle-signing-key": "pem" });
    const config = {
      secrets: store,
      signing: secret("bundle-signing-key"),
    } as unknown as ConfigResponse;

    await expect(checkSecrets(config, cwd)).resolves.toEqual({
      adapter: "team-store",
      references: [
        {
          name: "bundle-signing-key",
          fields: ["signing"],
          source: "adapter",
          inAdapter: true,
        },
      ],
    });
  });

  it("reports an adapter it can't read, keeping the environment's overrides", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    const store = {
      name: "team-store",
      set: async () => {},
      get: vi.fn(async () => {
        throw new Error("AccessDenied");
      }),
    };

    const status = await checkSecrets(configWith(store), cwd);

    expect(status?.error).toBe("AccessDenied");
    expect(
      status?.references.map(({ name, source }) => [name, source]),
    ).toEqual([
      ["asc-api-key", "environment"],
      ["release-keystore", undefined],
      ["bundle-signing-key", undefined],
    ]);
  });

  it("reads localSecrets() as it does: its variable, else its file on this machine", async () => {
    await writeLocalKey("asc-api-key", "{}", cwd);
    vi.stubEnv("HOT_UPDATER_BUNDLE_SIGNING_KEY", "pem");

    const status = await checkSecrets(configWith(localSecrets()), cwd);

    expect(status?.adapter).toBe("localSecrets");
    expect(
      status?.references.map(({ name, source }) => [name, source]),
    ).toEqual([
      ["asc-api-key", "adapter"],
      ["release-keystore", "missing"],
      ["bundle-signing-key", "environment"],
    ]);
  });

  it("is undefined for a config that references no secret", async () => {
    const store = teamStore({});
    await expect(
      checkSecrets({ secrets: store } as unknown as ConfigResponse, cwd),
    ).resolves.toBeUndefined();
    expect(store.get).not.toHaveBeenCalled();
  });
});

/** The JDK's keytool, when this machine has one: CI's runners do. */
const realKeytool = await findKeytool().catch(() => undefined);

describe.skipIf(!realKeytool)("checkSecrets with a JDK", () => {
  /** A PKCS12 upload keystore keytool creates, whose one password is `password`. */
  const pkcs12 = async (password: string) => {
    const file = path.join(cwd, "upload.p12");
    const created = await execa(
      process.env["JAVA_HOME"]
        ? path.join(process.env["JAVA_HOME"], "bin", "keytool")
        : "keytool",
      [
        "-genkeypair",
        "-noprompt",
        "-keystore",
        file,
        "-storetype",
        "PKCS12",
        "-alias",
        "upload",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "30",
        "-dname",
        "CN=spec",
        "-storepass",
        password,
        "-keypass",
        password,
      ],
      { reject: false },
    );
    expect(created.exitCode).toBe(0);
    return fs.readFile(file);
  };

  const configHolding = (value: string) =>
    ({
      secrets: teamStore({ "release-keystore": value }),
      nativeBuild: {
        android: {
          release: { signing: { keystore: secret("release-keystore") } },
        },
      },
    }) as unknown as ConfigResponse;

  it("says an upload keystore's stored key password doesn't unlock its key", async () => {
    const keystore = await pkcs12("store-secret-1");
    const value = androidKeystoreValue({
      keystore,
      storePassword: "store-secret-1",
      keyAlias: "upload",
      // EAS records it apart from the store password.
      keyPassword: "eas-key-secret",
    });

    const status = await checkSecrets(configHolding(value), cwd);

    expect(status?.references).toEqual([
      {
        name: "release-keystore",
        fields: ["nativeBuild.android.release.signing.keystore"],
        source: "adapter",
        inAdapter: true,
        refused: [
          'The key password doesn\'t unlock "upload".',
          "For PKCS12 keystores, the key password is the store password.",
        ].join("\n"),
      },
    ]);
  }, 60_000);

  it("finds nothing wrong with a keystore its passwords open", async () => {
    const keystore = await pkcs12("store-secret-1");
    const value = androidKeystoreValue({
      keystore,
      storePassword: "store-secret-1",
      keyAlias: "upload",
      keyPassword: "store-secret-1",
    });

    const status = await checkSecrets(configHolding(value), cwd);

    expect(status?.references[0]).not.toHaveProperty("refused");
    expect(status?.references[0]?.source).toBe("adapter");
  }, 60_000);
});

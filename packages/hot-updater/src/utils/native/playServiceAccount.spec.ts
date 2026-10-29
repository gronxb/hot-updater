import { stripVTControlCharacters } from "node:util";

import { linesWiderThan } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkPlayAccess } = vi.hoisted(() => ({
  checkPlayAccess: vi.fn(),
}));

// The Play Developer API's own specs cover the edit; here it answers.
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  checkPlayAccess,
}));

import {
  createCredentialResolver,
  maskSecretValues,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import {
  checkGooglePlay,
  formatGooglePlayReadiness,
  parseServiceAccountKey,
} from "./playServiceAccount";

const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIBspecprivatekey\n-----END PRIVATE KEY-----\n";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "my-app",
  private_key_id: "abc123",
  private_key: PRIVATE_KEY,
  client_email: EMAIL,
});
const KEYSTORE = JSON.stringify({
  keystore: Buffer.from("keystore bytes").toString("base64"),
  storePassword: "store-pass-spec",
  keyAlias: "upload",
  keyPassword: "key-pass-spec",
});
const INVITE_URL = `https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=${encodeURIComponent(EMAIL)}`;
const GUIDE = "Guide: https://hot-updater.dev/docs/native-builds/google-play";

const fakeSecrets = (values: Record<string, string>): SecretsAdapter => ({
  name: "spec-store",
  describe: (name) => `spec://${name}`,
  get: async (names) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  set: async () => {},
});

const check = async (values: Record<string, string>) => {
  const credentials = createCredentialResolver({
    secrets: fakeSecrets(values),
  });
  try {
    const readiness = await checkGooglePlay({
      credentials,
      packageName: "com.example.app",
      serviceAccount: { kind: "play-service-account" },
      keystore: { kind: "android-keystore" },
    });
    return {
      readiness,
      block: stripVTControlCharacters(formatGooglePlayReadiness(readiness)),
    };
  } finally {
    await credentials.dispose();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
    "HOT_UPDATER_ANDROID_KEYSTORE",
    "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
    "HOT_UPDATER_ANDROID_KEY_ALIAS",
    "HOT_UPDATER_ANDROID_KEY_PASSWORD",
  ]) {
    vi.stubEnv(name, "");
  }
  checkPlayAccess.mockResolvedValue({ status: "ready" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseServiceAccountKey", () => {
  it("reads a service account's JSON key, masking its private key", () => {
    expect(parseServiceAccountKey(KEY_FILE, "/tmp/my-app-abc123.json")).toEqual(
      { json: KEY_FILE, email: EMAIL, keyId: "abc123" },
    );
    expect(maskSecretValues(`key: ${PRIVATE_KEY}`)).not.toContain(
      "MIIBspecprivatekey",
    );
  });

  it("names google-services.json, the file people pick by mistake", () => {
    const googleServices = JSON.stringify({
      project_info: { project_id: "my-app" },
      client: [{ client_info: { mobilesdk_app_id: "1:2:android:3" } }],
    });

    expect(() =>
      parseServiceAccountKey(googleServices, "/app/google-services.json"),
    ).toThrow(
      [
        "google-services.json is google-services.json, not a service account key.",
        "https://hot-updater.dev/docs/native-builds/google-play",
      ].join("\n"),
    );
  });

  it("refuses a file that is no JSON, another kind of key, or one without its fields", () => {
    expect(() => parseServiceAccountKey("not json", "/tmp/key.json")).toThrow(
      "key.json is not a JSON key file.",
    );
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ type: "authorized_user", client_id: "x" }),
        "/tmp/key.json",
      ),
    ).toThrow(
      "key.json is not a service account key: its type isn't service_account.",
    );
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ type: "service_account", client_email: EMAIL }),
        "/tmp/key.json",
      ),
    ).toThrow("key.json has no private_key or client_email.");
  });

  it("masks the private key even when the file is refused", () => {
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ type: "service_account", private_key: PRIVATE_KEY }),
        "/tmp/key.json",
      ),
    ).toThrow("has no private_key or client_email");
    expect(maskSecretValues(PRIVATE_KEY)).not.toContain("MIIBspecprivatekey");
  });
});

describe("checkGooglePlay", () => {
  it("lists everything missing at once, with the command that stores each", async () => {
    const { readiness, block } = await check({});

    expect(readiness.ready).toBe(false);
    expect(block).toBe(
      [
        "Google Play isn't ready for com.example.app:",
        "✗ Service account key",
        "  npx hot-updater secrets put play-service-account <key.json>",
        "✗ Upload keystore",
        "  npx hot-updater secrets put android-keystore <upload.jks>",
        "· Play access          checked once the key is stored",
        GUIDE,
      ].join("\n"),
    );
    expect(checkPlayAccess).not.toHaveBeenCalled();
  });

  it("marks the keystore it found when only the key is missing", async () => {
    const { block } = await check({ "android-keystore": KEYSTORE });

    expect(block).toBe(
      [
        "Google Play isn't ready for com.example.app:",
        "✗ Service account key",
        "  npx hot-updater secrets put play-service-account <key.json>",
        "✓ Upload keystore",
        "· Play access          checked once the key is stored",
        GUIDE,
      ].join("\n"),
    );
  });

  it("names the invite, its permission, and its link when Google Play refuses the key", async () => {
    checkPlayAccess.mockResolvedValueOnce({ status: "denied", email: EMAIL });

    const { readiness, block } = await check({
      "play-service-account": KEY_FILE,
      "android-keystore": KEYSTORE,
    });

    expect(readiness.ready).toBe(false);
    expect(block).toBe(
      [
        "Google Play isn't ready for com.example.app:",
        "✓ Service account key",
        "✓ Upload keystore",
        "✗ Play access          invite the service account",
        `  ${EMAIL}`,
        "  App permission: Release apps to testing tracks",
        `  ${INVITE_URL}`,
        GUIDE,
      ].join("\n"),
    );
    expect(block).not.toContain("MIIBspecprivatekey");
    // Only the invite URL passes 80 columns: one unbroken word on its own
    // line, so it stays clickable.
    expect(
      linesWiderThan(block.split("\n").map((line) => `│  ${line}`)),
    ).toEqual([]);
  });

  it("asks for the first .aab when Google Play has no such app", async () => {
    checkPlayAccess.mockResolvedValueOnce({
      status: "not-found",
      email: EMAIL,
    });

    const { block } = await check({
      "play-service-account": KEY_FILE,
      "android-keystore": KEYSTORE,
    });

    expect(block).toContain(
      "✗ App in Play          upload the first .aab in Play Console",
    );
  });

  it("marks the key itself when Google's token endpoint refuses it", async () => {
    checkPlayAccess.mockResolvedValueOnce({
      status: "refused",
      email: EMAIL,
      reason:
        "Google refused the Play service account (HTTP 400).\nInvalid JWT",
    });

    const { block } = await check({
      "play-service-account": KEY_FILE,
      "android-keystore": KEYSTORE,
    });

    expect(block).toBe(
      [
        "Google Play isn't ready for com.example.app:",
        "✗ Service account key  Google refuses it",
        "  Google refused the Play service account (HTTP 400).",
        "  Invalid JWT",
        "✓ Upload keystore",
        "· Play access          checked once the key works",
        GUIDE,
      ].join("\n"),
    );
  });

  it("is ready when everything resolves and an edit opens", async () => {
    const { readiness } = await check({
      "play-service-account": KEY_FILE,
      "android-keystore": KEYSTORE,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.serviceAccount).toEqual({ json: KEY_FILE });
    expect(checkPlayAccess).toHaveBeenCalledWith({
      serviceAccount: { json: KEY_FILE },
      packageName: "com.example.app",
    });
  });

  it("breaks a long command for a named keystore so no line wraps", async () => {
    const credentials = createCredentialResolver({
      secrets: fakeSecrets({ "play-service-account": KEY_FILE }),
    });
    const readiness = await checkGooglePlay({
      credentials,
      packageName: "com.example.app",
      serviceAccount: { kind: "play-service-account" },
      keystore: { kind: "android-keystore", name: "release-keystore" },
    });
    await credentials.dispose();

    const lines = stripVTControlCharacters(
      formatGooglePlayReadiness(readiness),
    ).split("\n");
    expect(lines.slice(2, 5)).toEqual([
      "✗ Upload keystore",
      "  npx hot-updater secrets put release-keystore --kind android-keystore \\",
      "    <upload.jks>",
    ]);
    // Clack's three-column gutter included.
    expect(linesWiderThan(lines.map((line) => `│  ${line}`))).toEqual([]);
  });

  it("leaves a scheme without signing.keystore to Gradle, not failing on it", async () => {
    const credentials = createCredentialResolver({
      secrets: fakeSecrets({ "play-service-account": KEY_FILE }),
    });
    const readiness = await checkGooglePlay({
      credentials,
      packageName: "com.example.app",
      serviceAccount: { kind: "play-service-account" },
    });
    await credentials.dispose();

    expect(readiness.ready).toBe(true);
    expect(
      stripVTControlCharacters(formatGooglePlayReadiness(readiness)),
    ).toContain("· Upload keystore      Gradle's signing config");
  });
});

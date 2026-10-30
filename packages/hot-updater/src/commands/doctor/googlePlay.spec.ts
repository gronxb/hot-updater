import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  type ConfigResponse,
  resolveSecretsAdapter,
  secret,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { checkGooglePlay, formatGooglePlayStatus } from "./googlePlay";

const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  client_email: EMAIL,
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIBdoctor\n-----END PRIVATE KEY-----",
});

const secretsWith = (values: Record<string, string>): SecretsAdapter =>
  resolveSecretsAdapter({
    name: "spec-store",
    describe: (name) => `spec://${name}`,
    get: async (names) =>
      Object.fromEntries(names.map((name) => [name, values[name]])),
    set: async () => {},
  });

const config = (secrets: SecretsAdapter) =>
  ({
    secrets,
    nativeBuild: {
      android: {
        release: { packageName: "com.example.app" },
        staging: {
          packageName: "com.example.app",
          applicationId: "com.example.app.staging",
        },
        // Neither goes to Google Play.
        debug: { packageName: "com.example.app", variant: "Debug" },
        apk: { packageName: "com.example.apk", aab: false },
      },
    },
  }) as unknown as ConfigResponse;

let cwd: string;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const name of [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
  ]) {
    vi.stubEnv(name, "");
  }
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-play-"));
  await fs.writeFile(path.join(cwd, "package.json"), "{}");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("doctor's Google Play check", () => {
  it("checks nothing without a stored service account", async () => {
    await expect(
      checkGooglePlay(config(secretsWith({})), { cwd }),
    ).resolves.toBeUndefined();
    expect(checkPlayAccess).not.toHaveBeenCalled();
  });

  it("checks each package the config releases to Google Play, reporting the invite and the first upload", async () => {
    checkPlayAccess.mockImplementation(
      async ({ packageName }: { packageName: string }) =>
        packageName === "com.example.app"
          ? { status: "denied", email: EMAIL }
          : { status: "not-found", email: EMAIL },
    );

    const status = await checkGooglePlay(
      config(secretsWith({ "play-service-account": KEY_FILE })),
      { cwd },
    );

    expect(
      checkPlayAccess.mock.calls.map(([{ packageName }]) => packageName),
    ).toEqual(["com.example.app", "com.example.app.staging"]);
    const { ready, warned, text } = formatGooglePlayStatus(status!);
    expect([ready, warned]).toEqual([false, true]);
    expect(stripVTControlCharacters(text)).toBe(
      [
        "Google Play",
        "✗ com.example.app      invite the service account",
        `  ${EMAIL}`,
        "  App permission: Release apps to testing tracks",
        `  https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=${encodeURIComponent(EMAIL)}`,
        "✗ com.example.app.staging  upload the first .aab in Play Console",
        "Guide: https://hot-updater.dev/docs/native-builds/google-play",
      ].join("\n"),
    );
    expect(text).not.toContain("MIIBdoctor");
    // The invite URL is one unbroken word on its own line: nothing wraps.
    expect(
      linesWiderThan(
        stripVTControlCharacters(text)
          .split("\n")
          .map((line) => `│  ${line}`),
      ),
    ).toEqual([]);
  });

  it("marks each package the key reaches", async () => {
    checkPlayAccess.mockResolvedValue({ status: "ready" });

    const status = await checkGooglePlay(
      config(secretsWith({ "play-service-account": KEY_FILE })),
      { cwd },
    );

    expect(formatGooglePlayStatus(status!)).toEqual({
      ready: true,
      warned: false,
      text: expect.stringMatching(
        /^Google Play\n.*✓.* com\.example\.app\n.*✓.* com\.example\.app\.staging$/u,
      ),
    });
  });

  it("puts the detail under an application ID too long to share its line", () => {
    const { text } = formatGooglePlayStatus({
      packages: [
        {
          packageName: "com.example.mycompany.application.staging",
          access: { status: "not-found", email: EMAIL },
        },
      ],
    });

    expect(stripVTControlCharacters(text).split("\n").slice(1, 3)).toEqual([
      "✗ com.example.mycompany.application.staging",
      "  upload the first .aab in Play Console",
    ]);
    expect(
      linesWiderThan(
        stripVTControlCharacters(text)
          .split("\n")
          .map((line) => `│  ${line}`),
      ),
    ).toEqual([]);
  });

  it("says it couldn't check a package Google didn't answer for", async () => {
    checkPlayAccess.mockRejectedValue(new Error("fetch failed"));

    const status = await checkGooglePlay(
      config(secretsWith({ "play-service-account": KEY_FILE })),
      { cwd },
    );

    expect(
      stripVTControlCharacters(formatGooglePlayStatus(status!).text),
    ).toContain("✗ com.example.app      can't check\n  fetch failed");
  });

  it("marks a package whose upload keystore is missing, whatever its access", async () => {
    checkPlayAccess.mockImplementation(
      async ({ packageName }: { packageName: string }) =>
        packageName === "com.example.app"
          ? { status: "ready" }
          : { status: "not-found", email: EMAIL },
    );
    const missing = (name: string) => ({
      name,
      fields: [],
      required: true,
      source: "missing" as const,
      inAdapter: false,
    });

    const status = await checkGooglePlay(
      {
        ...config(secretsWith({ "play-service-account": KEY_FILE })),
        nativeBuild: {
          android: {
            release: {
              packageName: "com.example.app",
              signing: { keystore: secret("release-keystore") },
            },
            staging: {
              packageName: "com.example.app",
              applicationId: "com.example.app.staging",
              signing: { keystore: secret("staging-keystore") },
            },
          },
        },
      } as unknown as ConfigResponse,
      {
        cwd,
        secrets: {
          adapter: "spec-store",
          references: [
            missing("release-keystore"),
            missing("staging-keystore"),
          ],
          issues: [],
        },
      },
    );

    const { warned, text } = formatGooglePlayStatus(status!);
    expect(stripVTControlCharacters(text)).toBe(
      [
        "Google Play",
        "✗ com.example.app      upload keystore missing",
        "✗ com.example.app.staging  upload the first .aab in Play Console",
        "  Upload keystore staging-keystore is missing too.",
        "Guide: https://hot-updater.dev/docs/native-builds/google-play",
      ].join("\n"),
    );
    // The staging app's access is a warning of its own.
    expect(warned).toBe(true);
  });

  it("isn't a warning when the only ✗ is a keystore the Secrets error names", () => {
    const { ready, warned, text } = formatGooglePlayStatus({
      packages: [
        {
          packageName: "com.example.app",
          access: { status: "ready" },
          missingKeystore: "release-keystore",
        },
        { packageName: "com.example.app.staging", access: { status: "ready" } },
      ],
    });

    expect([ready, warned]).toEqual([false, false]);
    expect(stripVTControlCharacters(text)).toBe(
      [
        "Google Play",
        "✗ com.example.app      upload keystore missing",
        "✓ com.example.app.staging",
        "Guide: https://hot-updater.dev/docs/native-builds/google-play",
      ].join("\n"),
    );
  });
});

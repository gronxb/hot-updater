import type { CredentialResolver } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const {
    assertUnreservedEnv,
    createMinBundleId,
    parseSecretReference,
    secret,
  } = await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    assertUnreservedEnv,
    createMinBundleId,
    parseSecretReference,
    secret,
    getCwd: () => "/app",
    p: { log: { info: vi.fn() } },
  };
});
vi.mock("./utils/readBuiltApp", () => ({
  readBuiltApp: vi.fn(async () => ({ appVersion: "1.0", channel: "beta" })),
}));
vi.mock("./builder/runGradle", () => ({
  runGradle: vi.fn(async () => ({
    buildDirectory: "/app/android/app/build/outputs/apk/release",
    buildArtifactPath:
      "/app/android/app/build/outputs/apk/release/app-release.apk",
  })),
}));

import { secret } from "@hot-updater/cli-tools";

import { buildAndroid } from "./buildAndroid";
import { runGradle } from "./builder/runGradle";
import type { EnrichedNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5";

const scheme = (
  overrides: Partial<EnrichedNativeBuildAndroidScheme> = {},
): EnrichedNativeBuildAndroidScheme => ({
  aab: false,
  variant: "Release",
  appModuleName: "app",
  packageName: "com.example",
  applicationId: "com.example",
  hotUpdaterSchemeName: "release",
  ...overrides,
});

const keystoreResolver = () => {
  const resolve = vi.fn(async () => ({
    storeFile: "/tmp/release.keystore",
    storePassword: "store-secret",
    keyAlias: "release",
    keyPassword: "key-secret",
  }));
  return { resolve: resolve as typeof resolve & CredentialResolver["resolve"] };
};

beforeEach(() => {
  vi.mocked(runGradle).mockClear();
});

describe("buildAndroid", () => {
  it("compiles in the MIN_BUNDLE_ID it is given, and reports what the built artifact holds", async () => {
    const credentials = keystoreResolver();

    const { builtApp } = await buildAndroid({
      schemeConfig: scheme(),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(runGradle).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { extraParams: [`-PMIN_BUNDLE_ID=${MIN_BUNDLE_ID}`] },
        tasks: ["assembleRelease"],
        env: undefined,
      }),
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(builtApp).toEqual({ appVersion: "1.0", channel: "beta" });
  });

  it("signs a release variant with the scheme's keystore through the environment, off the command line", async () => {
    const credentials = keystoreResolver();

    await buildAndroid({
      schemeConfig: scheme({
        aab: true,
        signing: { keystore: secret("release-keystore") },
      }),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(credentials.resolve).toHaveBeenCalledWith({
      kind: "android-keystore",
      name: "release-keystore",
    });
    const [{ args, env, tasks }] = vi.mocked(runGradle).mock.calls[0]!;
    expect(tasks).toEqual(["bundleRelease"]);
    expect(env).toEqual({
      "ORG_GRADLE_PROJECT_android.injected.signing.store.file":
        "/tmp/release.keystore",
      "ORG_GRADLE_PROJECT_android.injected.signing.store.password":
        "store-secret",
      "ORG_GRADLE_PROJECT_android.injected.signing.key.alias": "release",
      "ORG_GRADLE_PROJECT_android.injected.signing.key.password": "key-secret",
    });
    expect(JSON.stringify(args)).not.toContain("secret");
  });

  it("issues a MIN_BUNDLE_ID with zero random bits without one, as the Gradle task does", async () => {
    await buildAndroid({ schemeConfig: scheme() });

    const [{ args }] = vi.mocked(runGradle).mock.calls[0]!;
    expect(args.extraParams?.[0]).toMatch(
      /^-PMIN_BUNDLE_ID=[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/,
    );
  });

  it.each(["Debug", "stagingDebug"])(
    "resolves no keystore for the %s variant",
    async (variant) => {
      const credentials = keystoreResolver();

      await buildAndroid({
        schemeConfig: scheme({
          variant,
          signing: { keystore: secret("release-keystore") },
        }),
        minBundleId: MIN_BUNDLE_ID,
        credentials,
      });

      expect(credentials.resolve).not.toHaveBeenCalled();
      expect(vi.mocked(runGradle).mock.calls[0]![0].env).toBeUndefined();
    },
  );
});

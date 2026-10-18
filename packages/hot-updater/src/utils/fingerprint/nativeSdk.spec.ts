import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNativeSdkEmbedsFingerprint,
  isNativeSdkWithoutBuildFingerprintError,
} from "./nativeSdk";

let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sdk-"));
  await fs.writeFile(path.join(project, "package.json"), "{}");
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

const installSdk = async (version: string, buildStep: boolean) => {
  const sdk = path.join(project, "node_modules/@hot-updater/react-native");
  await fs.mkdir(path.join(sdk, "android"), { recursive: true });
  await fs.writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@hot-updater/react-native",
      version,
      exports: { "./package.json": "./package.json" },
    }),
  );
  if (buildStep) {
    await fs.writeFile(
      path.join(sdk, "android/hot-updater-fingerprint.gradle"),
      "",
    );
  }
};

describe("assertNativeSdkEmbedsFingerprint", () => {
  it("passes an SDK that ships the build step that embeds the fingerprint", async () => {
    await installSdk("1.1.0", true);

    expect(() => assertNativeSdkEmbedsFingerprint(project)).not.toThrow();
  });

  it("rejects an SDK that reads the fingerprint from native metadata", async () => {
    await installSdk("1.0.8", false);

    let error: unknown;
    try {
      assertNativeSdkEmbedsFingerprint(project);
    } catch (thrown) {
      error = thrown;
    }
    expect(isNativeSdkWithoutBuildFingerprintError(error)).toBe(true);
    expect((error as Error).message).toContain(
      "@hot-updater/react-native@1.0.8",
    );
  });

  it("passes a project that doesn't install the SDK", () => {
    expect(() => assertNativeSdkEmbedsFingerprint(project)).not.toThrow();
  });
});

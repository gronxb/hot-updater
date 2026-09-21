import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lynx } from "../../../../lynx/dist/build.mjs";
import { validateSigningConfig } from "./validateSigningConfig";

const createPublicKey = () =>
  crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();

describe("Lynx native trust anchor and CLI signing validation", () => {
  let cwd: string;
  let publicKey: string;
  let otherKey: string;
  let config: ConfigResponse;

  beforeAll(() => {
    publicKey = createPublicKey();
    otherKey = createPublicKey();
  });
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-signing-"));
    const infoPlistPath = path.join(cwd, "Info.plist");
    const androidManifestPath = path.join(cwd, "AndroidManifest.xml");
    await fs.writeFile(
      infoPlistPath,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>HOT_UPDATER_PUBLIC_KEY</key><string>${publicKey}</string></dict></plist>`,
    );
    await fs.writeFile(
      androidManifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><meta-data android:name="com.hotupdater.PUBLIC_KEY" android:value="${publicKey.replaceAll("\n", "\\n")}" /></application></manifest>`,
    );
    config = {
      platform: {
        ios: { infoPlistPaths: [infoPlistPath] },
        android: { androidManifestPaths: [androidManifestPath] },
      },
      signing: {
        name: "test-signer",
        getPublicKey: async () => ({ publicKey }),
        sign: async ({ message }) => ({ signature: message }),
      },
    } as ConfigResponse;
  });
  afterEach(async () => fs.rm(cwd, { recursive: true, force: true }));

  async function validateNativeKey(key: string | null | undefined) {
    const plugin = lynx({
      build: async () => {
        throw new Error("Signing validation must precede compilation");
      },
      ...(key === undefined
        ? {}
        : {
            getBundleSigningPublicKey: async () =>
              key === null ? null : { publicKey: key },
          }),
    })({ cwd });
    const nativeKey = await plugin.nativeBuild!.getBundleSigningPublicKey!();
    return validateSigningConfig(config, {
      expectedPublicKey: publicKey,
      nativePublicKey: nativeKey?.publicKey ?? null,
      signingConfigSource: plugin.nativeBuild!.signingConfigSource,
    });
  }

  it("accepts the app-owned native key with real native files lacking RN signing entries", async () => {
    await fs.writeFile(
      config.platform.ios.infoPlistPaths[0]!,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Lynx</string></dict></plist>',
    );
    await fs.writeFile(
      config.platform.android.androidManifestPaths![0]!,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>',
    );
    const result = await validateNativeKey(publicKey);
    expect(result.isValid).toBe(true);
    expect(result.nativePublicKeys.ios.paths).toEqual([
      "Build plugin native configuration",
    ]);
  });

  it("rejects a mismatched resolver even when RN-style files contain the signer key", async () => {
    const result = await validateNativeKey(otherKey);
    expect(result.isValid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "PUBLIC_KEY_MISMATCH",
      "PUBLIC_KEY_MISMATCH",
    ]);
  });

  it.each([null, undefined])(
    "rejects a missing native key (%s) instead of accepting unrelated native-file keys",
    async (key) => {
      const result = await validateNativeKey(key);
      expect(result.isValid).toBe(false);
      expect(result.issues.map(({ code }) => code)).toEqual([
        "MISSING_PUBLIC_KEY",
        "MISSING_PUBLIC_KEY",
      ]);
      expect(
        result.issues.every(
          ({ message }) =>
            message.includes("build plugin") && !message.includes("Expo"),
        ),
      ).toBe(true);
    },
  );

  it("preserves existing native-file precedence when no plugin opts into the new mode", async () => {
    const result = await validateSigningConfig(config, {
      expectedPublicKey: publicKey,
      nativePublicKey: otherKey,
    });
    expect(result.isValid).toBe(true);
    expect(result.nativePublicKeys.ios.paths).not.toContain(
      "Build plugin native configuration",
    );
  });
});

import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as cliTools from "@hot-updater/cli-tools";
import { XML } from "expo/config-plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import withHotUpdater, { getPublicKeyFromConfig } from "./withHotUpdater";

const tempDirs: string[] = [];

const createKeyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("getPublicKeyFromConfig", () => {
  it("returns null when the Expo plugin public key is omitted", async () => {
    await expect(getPublicKeyFromConfig(undefined)).resolves.toBeNull();
    vi.stubEnv("HOT_UPDATER_PRIVATE_KEY", createKeyPair().privateKey);
    await expect(getPublicKeyFromConfig(undefined)).resolves.toBeNull();
  });

  it("loads publicKeyPath relative to the Expo project root", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { publicKey } = createKeyPair();
    await writeFile(path.join(dir, "public-key.pem"), publicKey);

    await expect(getPublicKeyFromConfig("public-key.pem", dir)).resolves.toBe(
      publicKey.trim(),
    );
  });

  it("rejects a missing publicKeyPath", async () => {
    await expect(
      getPublicKeyFromConfig("/missing/provider-public-key.pem"),
    ).rejects.toThrow("Failed to load publicKeyPath for bundle signing.");
  });

  it("rejects an empty publicKeyPath", async () => {
    await expect(getPublicKeyFromConfig("")).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
  });

  it("rejects a private PEM passed as publicKeyPath", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { privateKey } = createKeyPair();
    const publicKeyPath = path.join(dir, "public-key.pem");
    await writeFile(publicKeyPath, privateKey);

    await expect(getPublicKeyFromConfig(publicKeyPath)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
  });

  it("rejects an RSA public key weaker than 2048 bits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-public-key-"));
    tempDirs.push(dir);
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const publicKeyPath = path.join(dir, "public-key.pem");
    await writeFile(publicKeyPath, publicKey);

    await expect(getPublicKeyFromConfig(publicKeyPath)).rejects.toThrow(
      "Failed to load publicKeyPath for bundle signing.",
    );
  });
});

describe("withHotUpdater - Test Cases", () => {
  describe("Android", () => {
    // hot-updater's AndroidConfigParser keeps this value through its
    // fingerprint and channel rewrites; the CLI's own spec checks that.
    it("writes the public key into the manifest with its line breaks escaped", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-expo-mod-"));
      tempDirs.push(dir);
      const { publicKey } = createKeyPair();
      await writeFile(path.join(dir, "public-key.pem"), publicKey);
      vi.spyOn(cliTools, "loadConfig").mockResolvedValue({
        updateStrategy: "appVersion",
      } as Awaited<ReturnType<typeof cliTools.loadConfig>>);

      const config = withHotUpdater(
        {
          _internal: { projectRoot: dir },
          name: "Hot Updater Test",
          slug: "hot-updater-test",
        },
        { publicKeyPath: "public-key.pem" },
      );
      const manifestMod = config.mods?.android?.manifest;
      expect(manifestMod).toBeTypeOf("function");
      if (!manifestMod) {
        throw new Error("AndroidManifest mod was not registered");
      }

      const modResults = {
        manifest: {
          $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
          application: [{}],
        },
      } as Parameters<typeof manifestMod>[0]["modResults"];
      const result = await manifestMod({
        ...config,
        modRawConfig: config,
        modRequest: {
          introspect: true,
          modName: "manifest",
          platform: "android",
          platformProjectRoot: path.join(dir, "android"),
          projectRoot: dir,
        },
        modResults,
      });
      const publicKeyMetaData = result.modResults.manifest.application?.[0][
        "meta-data"
      ]?.find(
        (item) => item.$?.["android:name"] === "com.hotupdater.PUBLIC_KEY",
      );
      const expectedValue = publicKey.trim().replaceAll("\n", "\\n");

      expect(publicKeyMetaData?.$?.["android:value"]).toBe(expectedValue);
      expect(XML.format(result.modResults)).toContain(
        `android:value="${expectedValue}"`,
      );
    });

    it("removes a fingerprint.json the appVersion strategy leaves, so the build embeds no hash", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-expo-mod-"));
      tempDirs.push(dir);
      await writeFile(path.join(dir, "fingerprint.json"), "{}");
      vi.spyOn(cliTools, "loadConfig").mockResolvedValue({
        updateStrategy: "appVersion",
      } as Awaited<ReturnType<typeof cliTools.loadConfig>>);

      const config = withHotUpdater(
        {
          _internal: { projectRoot: dir },
          name: "Hot Updater Test",
          slug: "hot-updater-test",
        },
        {},
      );
      const manifestMod = config.mods?.android?.manifest;
      if (!manifestMod) {
        throw new Error("AndroidManifest mod was not registered");
      }
      await manifestMod({
        ...config,
        modRawConfig: config,
        modRequest: {
          introspect: true,
          modName: "manifest",
          platform: "android",
          platformProjectRoot: path.join(dir, "android"),
          projectRoot: dir,
        },
        modResults: {
          manifest: { $: {}, application: [{}] },
        } as Parameters<typeof manifestMod>[0]["modResults"],
      });

      await expect(
        access(path.join(dir, "fingerprint.json")),
      ).rejects.toThrow();
      // Prebuild loads the config without credentials.
      expect(vi.mocked(cliTools.loadConfig).mock.calls).toEqual([[null]]);
    });
  });
});

describe("withHotUpdater - Expo SDK floor", () => {
  it.each(["android", "ios"] as const)(
    "refuses to prebuild %s on an SDK below 55",
    async (platform) => {
      const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-expo-sdk-"));
      tempDirs.push(dir);
      await mkdir(path.join(dir, "node_modules/expo"), { recursive: true });
      await writeFile(
        path.join(dir, "node_modules/expo/package.json"),
        JSON.stringify({ name: "expo", version: "54.0.38" }),
      );
      vi.spyOn(cliTools, "loadConfig").mockResolvedValue({
        updateStrategy: "appVersion",
      } as Awaited<ReturnType<typeof cliTools.loadConfig>>);

      const config = withHotUpdater(
        {
          _internal: { projectRoot: dir },
          name: "Hot Updater Test",
          slug: "hot-updater-test",
        },
        {},
      );
      const mod =
        platform === "android"
          ? config.mods?.android?.manifest
          : config.mods?.ios?.infoPlist;
      if (!mod) throw new Error(`${platform} mod was not registered`);

      await expect(
        (mod as (config: unknown) => Promise<unknown>)({
          ...config,
          modRawConfig: config,
          modRequest: {
            introspect: true,
            modName: platform === "android" ? "manifest" : "infoPlist",
            platform,
            platformProjectRoot: path.join(dir, platform),
            projectRoot: dir,
          },
          modResults:
            platform === "android"
              ? { manifest: { $: {}, application: [{}] } }
              : {},
        }),
      ).rejects.toThrow(
        "Hot Updater requires Expo SDK 55 or later. Run:\nnpx expo install expo@^55.0.0 --fix",
      );
    },
  );
});

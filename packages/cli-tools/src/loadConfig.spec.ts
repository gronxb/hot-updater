import fs from "fs/promises";
import os from "os";
import path from "path";

import type {
  BundleSigningPlugin,
  ConfigInput,
  LocalSigningConfig,
} from "@hot-updater/plugin-core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import type { ConfigResponse } from "./loadConfig";

let projectRoot = "";

vi.mock("./cwd.js", () => ({
  getCwd: () => projectRoot,
}));

describe("ConfigResponse", () => {
  it("requires defaulted config while preserving optional plugin capabilities", () => {
    expectTypeOf<ConfigResponse["patch"]>().toEqualTypeOf<{
      enabled: boolean;
      maxBaseBundles: number;
    }>();
    expectTypeOf<ConfigResponse["compressStrategy"]>().toEqualTypeOf<
      "zip" | "tar.br" | "tar.gz"
    >();
    expectTypeOf<ConfigResponse["console"]["port"]>().toEqualTypeOf<number>();
    expectTypeOf<ConfigResponse["signing"]>().toEqualTypeOf<
      | BundleSigningPlugin
      | Extract<LocalSigningConfig, { enabled: true }>
      | undefined
    >();

    expectTypeOf<ConfigResponse["storage"]["getDownloadUrl"]>().toEqualTypeOf<
      ConfigInput["storage"]["getDownloadUrl"]
    >();
    expectTypeOf<ConfigResponse["database"]["dispose"]>().toEqualTypeOf<
      ConfigInput["database"]["dispose"]
    >();
    expect(Reflect.has({} as ConfigResponse["database"], "queries")).toBe(
      false,
    );
  });
});

const writeProjectFile = async (
  rootDir: string,
  relativePath: string,
  contents: string,
) => {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
};

describe("loadConfig", () => {
  beforeEach(async () => {
    vi.resetModules();
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-config-"),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_SIGNING_PROVIDER__");
    vi.restoreAllMocks();
  });

  it("returns defaults when the config file is missing", async () => {
    const { loadConfig } = await import("./loadConfig");

    const config = await loadConfig(null);

    expect(config.authorityId).toBe("default");
    expect(config.cacheDir).toBe(path.join("node_modules", ".hot-updater"));
    expect(config.updateStrategy).toBe("appVersion");
    expect(config.compressStrategy).toBe("zip");
    expect(config.patch.enabled).toBe(true);
    expect(config.patch.maxBaseBundles).toBe(3);
    expect(config.platform.android.androidManifestPaths).toEqual([]);
    expect(config.platform.ios.infoPlistPaths).toEqual([]);
    expect(config.console.port).toBe(1422);
    expect(typeof config.database).toBe("object");
  });

  it("preserves an explicit Release catalog authority", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      "export default { authorityId: 'project-a' };\n",
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.authorityId).toBe("project-a");
  });

  it("allows disabling the local CLI cache", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      ["export default {", "  cacheDir: null,", "};", ""].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.cacheDir).toBeNull();
  });

  it("discovers native config files from the project root by default", async () => {
    await writeProjectFile(
      projectRoot,
      "ios/HotUpdaterExample/Info.plist",
      "<plist />",
    );
    await writeProjectFile(
      projectRoot,
      "android/app/src/main/AndroidManifest.xml",
      "<manifest />",
    );
    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.platform.ios.infoPlistPaths).toEqual([
      "ios/HotUpdaterExample/Info.plist",
    ]);
    expect(config.platform.android.androidManifestPaths).toEqual([
      path.join("android", "app", "src", "main", "AndroidManifest.xml"),
    ]);
  });

  it("passes null context through to function configs", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  authorityId: options === null ? 'from-null-context' : 'wrong',",
        "});",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.authorityId).toBe("from-null-context");
  });

  it("preserves the configured signing provider identity", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "const provider = {",
        "  name: 'test-signer',",
        "  publicKeyPath: './public-key.pem',",
        "  getPublicKey: async () => ({ publicKey: 'public-key' }),",
        "  sign: async ({ message }) => ({ signature: message }),",
        "};",
        "globalThis.__HOT_UPDATER_TEST_SIGNING_PROVIDER__ = provider;",
        "export default {",
        "  signing: provider,",
        "};",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);
    const signing = config.signing;

    expect(signing).toBe(
      Reflect.get(globalThis, "__HOT_UPDATER_TEST_SIGNING_PROVIDER__"),
    );
  });

  it("normalizes explicit local signing config without reading the private key", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default {",
        "  signing: {",
        "    enabled: true,",
        "    privateKeyPath: './private-key-canary.pem',",
        "    publicKeyPath: './keys/public-key.pem',",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.signing).toEqual({
      enabled: true,
      privateKeyPath: "./private-key-canary.pem",
      publicKeyPath: "./keys/public-key.pem",
    });
  });

  it.each([
    "{ enabled: false }",
    "{ enabled: false, privateKeyPath: '/missing/key.pem' }",
    "{ privateKeyPath: '/missing/key.pem' }",
  ])(
    "removes inactive local signing from the merged config: %s",
    async (signing) => {
      await writeProjectFile(
        projectRoot,
        "hot-updater.config.ts",
        `export default { signing: ${signing} };`,
      );
      const { loadConfig } = await import("./loadConfig");
      expect((await loadConfig(null)).signing).toBeUndefined();
    },
  );

  it("loads the unchanged v0 local config without requiring publicKeyPath", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      "export default { signing: { enabled: true, privateKeyPath: './private.pem' } };",
    );
    const { loadConfig } = await import("./loadConfig");
    expect((await loadConfig(null)).signing).toEqual({
      enabled: true,
      privateKeyPath: "./private.pem",
    });
  });

  it("preserves legacy merge semantics for arrays in user config", async () => {
    await writeProjectFile(
      projectRoot,
      "ios/HotUpdaterExample/Info.plist",
      "<plist />",
    );
    await writeProjectFile(
      projectRoot,
      "android/app/src/main/res/values/strings.xml",
      "<resources />",
    );
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  authorityId: options?.channel ?? 'staging',",
        "  updateStrategy: 'fingerprint',",
        "  console: {",
        "    port: 3001,",
        "  },",
        "  fingerprint: {",
        "    extraSources: ['src/custom.ts'],",
        "  },",
        "  patch: {",
        "    enabled: true,",
        "    maxBaseBundles: 3,",
        "  },",
        "  platform: {",
        "    android: {",
        "      androidManifestPaths: ['android/custom/AndroidManifest.xml'],",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig({ platform: "android", channel: "beta" });

    expect(config.authorityId).toBe("beta");
    expect(config.updateStrategy).toBe("fingerprint");
    expect(config.console.port).toBe(3001);
    expect(config.fingerprint.extraSources).toEqual(["src/custom.ts"]);
    expect(config.patch).toEqual({
      enabled: true,
      maxBaseBundles: 3,
    });
    expect(config.platform.android.androidManifestPaths).toEqual([
      "android/custom/AndroidManifest.xml",
    ]);
    expect(config.platform.ios.infoPlistPaths).toEqual([
      "ios/HotUpdaterExample/Info.plist",
    ]);
  });

  it("keeps platform-scoped fingerprint extraSources intact", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default {",
        "  updateStrategy: 'fingerprint',",
        "  fingerprint: {",
        "    extraSources: {",
        "      ios: ['ios/.env'],",
        "      android: ['android/local.properties'],",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.fingerprint.extraSources).toEqual({
      ios: ["ios/.env"],
      android: ["android/local.properties"],
    });
  });
});

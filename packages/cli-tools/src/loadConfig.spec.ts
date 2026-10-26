import fs from "fs/promises";
import os from "os";
import path from "path";

import type {
  AnyHotUpdaterPlugin,
  BundleSigningAdapter,
  ConfigInput,
  ConfiguredDatabase,
  LocalSigningConfig,
  StorageAdapter,
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
    expectTypeOf<ConfigResponse["console"]["port"]>().toEqualTypeOf<number>();
    expectTypeOf<ConfigResponse["signing"]>().toEqualTypeOf<
      | BundleSigningAdapter
      | Extract<LocalSigningConfig, { enabled: true }>
      | undefined
    >();

    expectTypeOf<ConfigResponse["database"]>().toEqualTypeOf<
      ConfiguredDatabase | undefined
    >();
    expectTypeOf<ConfigResponse["storage"]>().toEqualTypeOf<
      StorageAdapter | undefined
    >();
    expectTypeOf<ConfigResponse["plugins"]>().toEqualTypeOf<
      readonly AnyHotUpdaterPlugin[]
    >();
    expectTypeOf<ConfigInput>().not.toHaveProperty("server");
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

    expect(config).not.toHaveProperty("catalogId");
    expect(config).not.toHaveProperty("authorityId");
    expect(config.cacheDir).toBe(path.join("node_modules", ".hot-updater"));
    expect(config.updateStrategy).toBe("appVersion");
    expect(config.patch.enabled).toBe(true);
    expect(config.patch.maxBaseBundles).toBe(3);
    expect(config.platform.android.androidManifestPaths).toEqual([]);
    expect(config.platform.ios.infoPlistPaths).toEqual([]);
    expect(config.console.port).toBe(1422);
    // No placeholder: commands that need them say what to set.
    expect(config.database).toBeUndefined();
    expect(config.storage).toBeUndefined();
    expect(config.plugins).toEqual([]);
  });

  it("takes the database, storage, and plugins whole, as the config made them", async () => {
    const official = Symbol.for("@hot-updater/server/official-plugin");
    const plugin = Object.freeze({
      id: "insights",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
      [official]: true,
    });
    const settings = {
      database: Object.freeze({
        name: "standalone-repository",
        core: {},
        fetchAdmin: async () => new Response(),
      }),
      storage: Object.freeze({ name: "s3Storage", protocol: "s3" }),
      plugins: Object.freeze([plugin]),
    };
    Reflect.set(globalThis, "__HOT_UPDATER_TEST_SETTINGS__", settings);
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      "export default { ...globalThis.__HOT_UPDATER_TEST_SETTINGS__ };\n",
    );

    try {
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      expect(config.database).toBe(settings.database);
      expect(config.storage).toBe(settings.storage);
      expect(config.plugins).toBe(settings.plugins);
      expect(Reflect.get(config.plugins[0]!, official)).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_SETTINGS__");
    }
  });

  it("defaults secrets to the environment and `localSecrets()`'s store, and registers it for secret: references", async () => {
    const { loadConfig } = await import("./loadConfig");
    const { getConfiguredAdapter, getConfiguredSecrets } =
      await import("./secrets");

    const config = await loadConfig(null);

    expect(config.secrets.name).toBe("localSecrets");
    expect(config.secrets.set).toBeTypeOf("function");
    expect(getConfiguredAdapter(config.secrets)).toBeUndefined();
    expect(getConfiguredSecrets()).toBe(config.secrets);
  });

  it("takes the secrets adapter whole, and the config's own copy of secretEnv reads through it without touching process.env", async () => {
    // Given: a config that imports secretEnv as its own module copy, as a
    // project's config imports hot-updater
    vi.stubEnv("HU_SPEC_DEPLOY_TOKEN", undefined);
    const get = vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, `store:${name}`])),
    );
    const secrets = Object.freeze({ name: "spec-store", get });
    Reflect.set(globalThis, "__HOT_UPDATER_TEST_SECRETS__", secrets);
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        `import { secretEnv } from ${JSON.stringify(path.join(import.meta.dirname, "secrets.ts"))};`,
        'const deploy = secretEnv(["HU_SPEC_DEPLOY_TOKEN"]);',
        "export default {",
        "  secrets: globalThis.__HOT_UPDATER_TEST_SECRETS__,",
        '  storage: { name: "s3Storage", protocol: "s3", credentials: deploy },',
        "};",
        "",
      ].join("\n"),
    );
    const before = { ...process.env };

    try {
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      // Loading reads no secret.
      expect(get).not.toHaveBeenCalled();

      // When: the storage adapter asks for its credentials
      const credentials = (
        config.storage as unknown as {
          credentials: () => Promise<Record<string, string>>;
        }
      ).credentials;
      const values = await credentials();

      // Then: the config's adapter, with `localSecrets()`'s store after it
      const { getConfiguredAdapter } = await import("./secrets");
      expect(getConfiguredAdapter(config.secrets)).toBe(secrets);
      expect(config.secrets.name).toBe("spec-store");
      expect(values).toEqual({
        HU_SPEC_DEPLOY_TOKEN: "store:HU_SPEC_DEPLOY_TOKEN",
      });
      expect(get).toHaveBeenCalledWith(["HU_SPEC_DEPLOY_TOKEN"], {
        cwd: expect.any(String),
      });
      expect(process.env).toEqual(before);
      // The CLI's own masker hides what the config's copy resolved.
      const { maskSecretValues } = await import("./secretMasking");
      expect(maskSecretValues("token store:HU_SPEC_DEPLOY_TOKEN")).toBe(
        "token ********",
      );
    } finally {
      Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_SECRETS__");
      const { setConfiguredSecrets, withLocalKeyStore } =
        await import("./secrets");
      setConfiguredSecrets(withLocalKeyStore());
      vi.unstubAllEnvs();
    }
  });

  it("binds each secretEnv to the secrets of the config that created it, whatever config loads after", async () => {
    // Given: a config function whose secrets adapter depends on the platform
    const storeOf = (name: string) => ({
      name,
      get: vi.fn(async (names: readonly string[]) =>
        Object.fromEntries(names.map((key) => [key, `${name}:${key}`])),
      ),
    });
    const stores = {
      ios: storeOf("ios-store"),
      android: storeOf("android-store"),
      none: storeOf("none-store"),
    };
    vi.stubEnv("HU_SPEC_SCOPED_TOKEN", undefined);
    Reflect.set(globalThis, "__HOT_UPDATER_TEST_SECRETS__", stores);
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        `import { secretEnv } from ${JSON.stringify(path.join(import.meta.dirname, "secrets.ts"))};`,
        "export default (options) => ({",
        "  secrets: globalThis.__HOT_UPDATER_TEST_SECRETS__[options?.platform ?? 'none'],",
        '  storage: { name: "s3Storage", protocol: "s3", credentials: secretEnv(["HU_SPEC_SCOPED_TOKEN"]) },',
        "});",
        "",
      ].join("\n"),
    );
    type Credentials = { credentials: () => Promise<Record<string, string>> };

    try {
      const { loadConfig, loadPlatformConfigs } = await import("./loadConfig");
      const [ios, android] = await loadPlatformConfigs(["ios", "android"], {
        channel: "production",
      });
      // As the fingerprint loads it, after the platform configs.
      await loadConfig(null);

      // Then
      await expect(
        (ios!.config.storage as unknown as Credentials).credentials(),
      ).resolves.toEqual({
        HU_SPEC_SCOPED_TOKEN: "ios-store:HU_SPEC_SCOPED_TOKEN",
      });
      await expect(
        (android!.config.storage as unknown as Credentials).credentials(),
      ).resolves.toEqual({
        HU_SPEC_SCOPED_TOKEN: "android-store:HU_SPEC_SCOPED_TOKEN",
      });
      expect(stores.none.get).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_SECRETS__");
      const { setConfiguredSecrets, withLocalKeyStore } =
        await import("./secrets");
      setConfiguredSecrets(withLocalKeyStore());
      vi.unstubAllEnvs();
    }
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

  it("narrows the discovered native config files to the ones the config lists", async () => {
    for (const file of [
      "ios/App/Info.plist",
      "ios/AppTests/Info.plist",
      "ios/NotificationService/Info.plist",
    ]) {
      await writeProjectFile(projectRoot, file, "<plist />");
    }
    for (const file of [
      "android/app/src/debug/AndroidManifest.xml",
      "android/app/src/main/AndroidManifest.xml",
    ]) {
      await writeProjectFile(projectRoot, file, "<manifest />");
    }
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default {",
        "  platform: {",
        "    ios: { infoPlistPaths: ['ios/NotificationService/Info.plist'] },",
        "    android: {",
        "      androidManifestPaths: ['android/app/src/main/AndroidManifest.xml'],",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.platform.ios.infoPlistPaths).toEqual([
      "ios/NotificationService/Info.plist",
    ]);
    expect(config.platform.android.androidManifestPaths).toEqual([
      "android/app/src/main/AndroidManifest.xml",
    ]);
  });

  it("loads the file once for several platforms, so a config object gives them the same adapters", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "globalThis.__HOT_UPDATER_TEST_LOADS__ = (globalThis.__HOT_UPDATER_TEST_LOADS__ ?? 0) + 1;",
        "export default {",
        "  database: { name: 'memory', adapter: {} },",
        "  storage: { name: 'r2Storage', protocol: 'r2' },",
        "  plugins: [],",
        "};",
        "",
      ].join("\n"),
    );

    try {
      const { loadPlatformConfigs } = await import("./loadConfig");
      const [ios, android] = await loadPlatformConfigs(["ios", "android"], {
        channel: "production",
      });

      expect(Reflect.get(globalThis, "__HOT_UPDATER_TEST_LOADS__")).toBe(1);
      expect(ios!.platform).toBe("ios");
      expect(android!.platform).toBe("android");
      expect(android!.config.database).toBe(ios!.config.database);
      expect(android!.config.storage).toBe(ios!.config.storage);
      expect(android!.config.plugins).toBe(ios!.config.plugins);
    } finally {
      Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_LOADS__");
    }
  });

  it("calls a config function once per platform, whose adapters are that platform's own", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default ({ platform, channel }) => ({",
        "  database: { name: `memory-${platform}-${channel}`, adapter: {} },",
        "  storage: { name: 'r2Storage', protocol: 'r2' },",
        "});",
        "",
      ].join("\n"),
    );

    const { loadPlatformConfigs } = await import("./loadConfig");
    const [ios, android] = await loadPlatformConfigs(["ios", "android"], {
      channel: "beta",
    });

    expect(ios!.config.database?.name).toBe("memory-ios-beta");
    expect(android!.config.database?.name).toBe("memory-android-beta");
    expect(android!.config.storage).not.toBe(ios!.config.storage);
  });

  it("passes null context through to function configs", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  cacheDir: options === null ? 'from-null-context' : 'wrong',",
        "});",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.cacheDir).toBe("from-null-context");
  });

  it("preserves the configured signing provider identity", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "const provider = {",
        "  name: 'test-signer',",
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
    });
  });

  it.each([
    "{ enabled: false }",
    "{ enabled: false, privateKeyPath: '/missing/key.pem' }",
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

  it("rejects a local signing config without an explicit enabled state", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      "export default { signing: { privateKeyPath: '/missing/key.pem' } };",
    );
    const { loadConfig } = await import("./loadConfig");

    await expect(loadConfig(null)).rejects.toThrow(
      "Bundle signing must be a local key config or signing adapter",
    );
  });

  it("loads local signing config", async () => {
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
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  cacheDir: options?.channel ?? 'staging',",
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

    expect(config.cacheDir).toBe("beta");
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

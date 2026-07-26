import type {
  NodeStoragePlugin,
  StoragePluginV2,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoadConfigStorageHarness = Readonly<{
  writeConfig(contents: string): Promise<void>;
}>;

let fixtureOrdinal = 0;
const fixtureKeys: string[] = [];

const exposeFixture = (value: unknown): string => {
  fixtureOrdinal += 1;
  const key = `__hotUpdaterTodo7Storage${process.pid}_${fixtureOrdinal}`;
  Reflect.set(process, key, value);
  fixtureKeys.push(key);
  return key;
};

const useStorageFixture = async (
  harness: LoadConfigStorageHarness,
  value: unknown,
): Promise<void> => {
  const key = exposeFixture(value);
  await harness.writeConfig(
    `export default { storage: Reflect.get(process, ${JSON.stringify(key)}) };\n`,
  );
};

const createLegacyPlugin = (
  onUnmount?: () => void | Promise<void>,
): NodeStoragePlugin => ({
  name: "legacy",
  supportedProtocol: "legacy",
  profiles: {
    node: {
      delete: async () => undefined,
      downloadFile: async () => undefined,
      exists: async () => true,
      upload: async () => ({ storageUri: "legacy://bundle" }),
    },
  },
  onUnmount,
});

export const registerLoadConfigStorageLifecycleCases = (
  harness: LoadConfigStorageHarness,
): void => {
  afterEach(() => {
    for (const key of fixtureKeys.splice(0)) {
      Reflect.deleteProperty(process, key);
    }
  });

  describe("loadConfig storage lifecycle", () => {
    it.each([
      ["synchronous", (plugin: NodeStoragePlugin) => () => plugin],
      ["asynchronous", (plugin: NodeStoragePlugin) => async () => plugin],
    ])("supports a %s legacy factory", async (_kind, createFactory) => {
      // Given
      const plugin = createLegacyPlugin();
      const factory = vi.fn(createFactory(plugin));
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const facade = await config.storage();

      // Then
      expect(factory).toHaveBeenCalledOnce();
      expect(facade).not.toBe(plugin);
      expect(facade.profiles).toBe(plugin.profiles);
      expect("onUnmount" in facade).toBe(false);
    });

    it("shares one concurrent factory attempt and returns fresh borrowed facades", async () => {
      // Given
      const plugin = createLegacyPlugin();
      const deferred = Promise.withResolvers<NodeStoragePlugin>();
      const factory = vi.fn(() => deferred.promise);
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const first = config.storage();
      const second = config.storage();
      deferred.resolve(plugin);
      const [firstFacade, secondFacade] = await Promise.all([first, second]);

      // Then
      expect(factory).toHaveBeenCalledOnce();
      expect(firstFacade).not.toBe(secondFacade);
      expect(firstFacade.profiles).toBe(plugin.profiles);
      expect(secondFacade.profiles).toBe(plugin.profiles);
    });

    it("clears a rejected attempt for exactly one later retry", async () => {
      // Given
      const plugin = createLegacyPlugin();
      const factory = vi
        .fn<() => Promise<NodeStoragePlugin>>()
        .mockRejectedValueOnce(new TypeError("initialization failed"))
        .mockResolvedValue(plugin);
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const firstAttempt = config.storage();
      await expect(firstAttempt).rejects.toMatchObject({
        code: "invalid-storage-input",
      });
      const facade = await config.storage();

      // Then
      expect(factory).toHaveBeenCalledTimes(2);
      expect(facade.profiles).toBe(plugin.profiles);
    });

    it("keeps independent materialization caches per response", async () => {
      // Given
      const plugin = createLegacyPlugin();
      const factory = vi.fn(() => plugin);
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const firstConfig = await loadConfig(null);
      const secondConfig = await loadConfig(null);

      // When
      await Promise.all([firstConfig.storage(), secondConfig.storage()]);

      // Then
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it("does not materialize unused storage and disposes idempotently", async () => {
      // Given
      const factory = vi.fn(() => createLegacyPlugin());
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const firstDispose = config.disposeStorage();
      const secondDispose = config.disposeStorage();
      await Promise.all([firstDispose, secondDispose]);

      // Then
      expect(factory).not.toHaveBeenCalled();
      expect(firstDispose).toBe(secondDispose);
      await expect(config.storage()).rejects.toMatchObject({
        code: "disposed",
      });
    });

    it("waits for in-flight initialization before disposing once", async () => {
      // Given
      const onUnmount = vi.fn();
      const plugin = createLegacyPlugin(onUnmount);
      const deferred = Promise.withResolvers<NodeStoragePlugin>();
      await useStorageFixture(harness, () => deferred.promise);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      const storage = config.storage();

      // When
      const dispose = config.disposeStorage();
      deferred.resolve(plugin);

      // Then
      await expect(storage).rejects.toMatchObject({ code: "disposed" });
      await dispose;
      expect(onUnmount).toHaveBeenCalledOnce();
    });

    it("owns direct legacy cleanup while lending a teardown-free facade", async () => {
      // Given
      const onUnmount = vi.fn();
      const plugin = createLegacyPlugin(onUnmount);
      await useStorageFixture(harness, plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const facade = await config.storage();
      await config.disposeStorage();
      await config.disposeStorage();

      // Then
      expect(facade).not.toBe(plugin);
      expect("onUnmount" in facade).toBe(false);
      expect(onUnmount).toHaveBeenCalledOnce();
    });

    it("disposes an unused direct plugin because the response owns it", async () => {
      // Given
      const onUnmount = vi.fn();
      await useStorageFixture(harness, createLegacyPlugin(onUnmount));
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      await config.disposeStorage();

      // Then
      expect(onUnmount).toHaveBeenCalledOnce();
    });

    it("owns direct v2 cleanup without lending teardown authority", async () => {
      // Given
      const onUnmount = vi.fn();
      const plugin = {
        name: "v2-direct",
        protocol: "v2",
        put: vi.fn(),
        head: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        onUnmount,
      } satisfies StoragePluginV2;
      await useStorageFixture(harness, plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const facade = await config.storage();
      await config.disposeStorage();
      await config.disposeStorage();

      // Then
      expect("onUnmount" in facade).toBe(false);
      expect(onUnmount).toHaveBeenCalledOnce();
    });

    it("rejects malformed direct storage on first use", async () => {
      // Given
      await useStorageFixture(harness, { name: "malformed" });
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const result = config.storage();

      // Then
      await expect(result).rejects.toMatchObject({
        code: "invalid-storage-input",
      });
    });

    it("reports missing default storage only when first used", async () => {
      // Given
      await harness.writeConfig("export default {};\n");
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const result = config.storage();

      // Then
      await expect(result).rejects.toMatchObject({
        code: "invalid-storage-input",
      });
    });

    it("rejects a v2 second thunk after suppressing cleanup failure", async () => {
      // Given
      const onUnmount = vi.fn(async () => {
        throw new TypeError("cleanup failed");
      });
      const plugin = {
        name: "v2",
        protocol: "v2",
        put: vi.fn(),
        head: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        onUnmount,
      } satisfies StoragePluginV2;
      await useStorageFixture(harness, async () => plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      try {
        // When
        const result = config.storage();

        // Then
        await expect(result).rejects.toMatchObject({ code: "v2-factory" });
        expect(onUnmount).toHaveBeenCalledOnce();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });
};

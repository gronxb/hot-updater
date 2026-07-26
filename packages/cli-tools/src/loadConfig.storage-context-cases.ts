import {
  createStoragePlugin,
  type StorageOperationContext,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoadConfigStorageHarness = Readonly<{
  writeConfig(contents: string): Promise<void>;
}>;

let fixtureOrdinal = 0;
const fixtureKeys: string[] = [];

const useStorageFixture = async (
  harness: LoadConfigStorageHarness,
  value: unknown,
): Promise<void> => {
  fixtureOrdinal += 1;
  const key = `__hotUpdaterTodo7Context${process.pid}_${fixtureOrdinal}`;
  Reflect.set(process, key, value);
  fixtureKeys.push(key);
  await harness.writeConfig(
    `export default { storage: Reflect.get(process, ${JSON.stringify(key)}) };\n`,
  );
};

export const registerLoadConfigStorageContextCases = (
  harness: LoadConfigStorageHarness,
): void => {
  afterEach(() => {
    for (const key of fixtureKeys.splice(0)) {
      Reflect.deleteProperty(process, key);
    }
  });

  describe("loadConfig storage contexts", () => {
    it("creates distinct facades bound to each exact concrete context", async () => {
      // Given
      const contexts: StorageOperationContext[] = [];
      const plugin = createStoragePlugin({
        name: "contexts",
        protocol: "memory",
        plugin: () => ({
          delete: async () => ({ kind: "deleted" }),
          get: async () => ({ kind: "not-found" }),
          head: async ({ context }) => {
            contexts.push(context);
            return {
              kind: "found",
              storageUri: "memory://bundle",
              metadata: { contentLength: 0 },
            };
          },
          put: async () => ({
            kind: "stored",
            storageUri: "memory://bundle",
          }),
        }),
      });
      await useStorageFixture(harness, plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      const firstContext = Object.freeze({
        target: "node",
        environment: Object.freeze({ request: "first" }),
        bindings: Object.freeze({}),
      }) satisfies StorageOperationContext;
      const secondContext = Object.freeze({
        target: "node",
        environment: Object.freeze({ request: "second" }),
        bindings: Object.freeze({}),
      }) satisfies StorageOperationContext;

      // When
      const firstFacade = await config.storage(firstContext);
      const secondFacade = await config.storage(secondContext);
      await firstFacade.profiles.node.exists("memory://bundle");
      await secondFacade.profiles.node.exists("memory://bundle");

      // Then
      expect(firstFacade).not.toBe(secondFacade);
      expect(contexts).toEqual([firstContext, secondContext]);
    });

    it("keeps live binding identity usable in a supplied context", async () => {
      // Given
      const binding = { count: 0 };
      const plugin = createStoragePlugin({
        name: "binding",
        protocol: "memory",
        plugin: () => ({
          delete: async () => ({ kind: "deleted" }),
          get: async () => ({ kind: "not-found" }),
          head: async ({ context }) => {
            const value = context.bindings["LIVE"];
            if (value === binding) {
              binding.count += 1;
            }
            return { kind: "not-found" };
          },
          put: async () => ({
            kind: "stored",
            storageUri: "memory://bundle",
          }),
        }),
      });
      await useStorageFixture(harness, plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      const context = Object.freeze({
        target: "node",
        environment: Object.freeze({}),
        bindings: Object.freeze({ LIVE: binding }),
      }) satisfies StorageOperationContext;

      // When
      const facade = await config.storage(context);
      await facade.profiles.node.exists("memory://missing");

      // Then
      expect(binding.count).toBe(1);
    });

    it("creates a fresh frozen string-only Node context per operation", async () => {
      // Given
      const original = process.env["HOT_UPDATER_TODO7_CONTEXT"];
      const contexts: StorageOperationContext[] = [];
      const plugin = createStoragePlugin({
        name: "fallback-context",
        protocol: "memory",
        plugin: () => ({
          delete: async () => ({ kind: "deleted" }),
          get: async () => ({ kind: "not-found" }),
          head: async ({ context }) => {
            contexts.push(context);
            return { kind: "not-found" };
          },
          put: async () => ({
            kind: "stored",
            storageUri: "memory://bundle",
          }),
        }),
      });
      await useStorageFixture(harness, plugin);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);
      const facade = await config.storage();

      try {
        // When
        process.env["HOT_UPDATER_TODO7_CONTEXT"] = "first";
        await facade.profiles.node.exists("memory://first");
        process.env["HOT_UPDATER_TODO7_CONTEXT"] = "second";
        await facade.profiles.node.exists("memory://second");

        // Then
        expect(contexts).toHaveLength(2);
        expect(contexts[0]).not.toBe(contexts[1]);
        expect(
          contexts.map(
            ({ environment }) => environment["HOT_UPDATER_TODO7_CONTEXT"],
          ),
        ).toEqual(["first", "second"]);
        for (const context of contexts) {
          expect(context.target).toBe("node");
          expect(context.bindings).toEqual({});
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.environment)).toBe(true);
          expect(Object.isFrozen(context.bindings)).toBe(true);
        }
      } finally {
        if (original === undefined) {
          delete process.env["HOT_UPDATER_TODO7_CONTEXT"];
        } else {
          process.env["HOT_UPDATER_TODO7_CONTEXT"] = original;
        }
      }
    });

    it("preserves user storage identity over defaults", async () => {
      // Given
      const factory = vi.fn(() => ({
        name: "precedence",
        supportedProtocol: "precedence",
        profiles: {
          node: {
            delete: async () => undefined,
            downloadFile: async () => undefined,
            exists: async () => true,
            upload: async () => ({ storageUri: "precedence://bundle" }),
          },
        },
      }));
      await useStorageFixture(harness, factory);
      const { loadConfig } = await import("./loadConfig");
      const config = await loadConfig(null);

      // When
      const storage = await config.storage();

      // Then
      expect(factory).toHaveBeenCalledOnce();
      expect(storage.name).toBe("precedence");
    });
  });
};

import { describe, expect, it, vi } from "vitest";

import { createStoragePlugin } from "./createStoragePlugin";
import {
  type StorageOperationContext,
  type StoragePluginImplementation,
  type StoragePluginErrorCode,
} from "./storage";

const context: StorageOperationContext = Object.freeze({
  target: "node",
  environment: Object.freeze({}),
  bindings: Object.freeze({}),
});

const createImplementation = (): StoragePluginImplementation => ({
  async put(input) {
    return { kind: "stored", storageUri: `memory://${input.key}` };
  },
  async head(input) {
    return {
      kind: "found",
      storageUri: input.storageUri,
      metadata: { contentLength: 1 },
    };
  },
  async get(input) {
    return {
      kind: "found",
      storageUri: input.storageUri,
      body: new ReadableStream<Uint8Array>(),
      metadata: { contentLength: 1 },
    };
  },
  async delete() {
    return { kind: "deleted" };
  },
});

const expectCode = async (
  operation: Promise<unknown>,
  code: StoragePluginErrorCode,
) => {
  await expect(operation).rejects.toMatchObject({ code });
};

export const registerStorageV2FactoryTests = () => {
  describe("Storage v2 direct factory", () => {
    it("returns one frozen direct handle and forwards context identity", async () => {
      // Given
      const implementation = createImplementation();
      const put = vi.spyOn(implementation, "put");
      const factory = vi.fn(() => implementation);

      // When
      const plugin = createStoragePlugin({
        name: "memory",
        protocol: "memory",
        plugin: factory,
      });
      await plugin.put({
        key: "bundle",
        body: new Uint8Array([1]),
        contentLength: 1,
        context,
      });

      // Then
      expect(factory).toHaveBeenCalledOnce();
      expect(typeof plugin).toBe("object");
      expect(Object.isFrozen(plugin)).toBe(true);
      expect(plugin).toMatchObject({ name: "memory", protocol: "memory" });
      expect(put.mock.calls[0]?.[0].context).toBe(context);
      expect("issueDownload" in plugin).toBe(false);
      expect("list" in plugin).toBe(false);
      expect("onUnmount" in plugin).toBe(false);
    });

    it.each([
      { name: "", protocol: "memory" },
      { name: "   ", protocol: "memory" },
      { name: "memory", protocol: "Memory" },
      { name: "memory", protocol: "1memory" },
      { name: "memory", protocol: "memory:" },
      { name: "memory", protocol: "" },
    ])("rejects invalid factory input %#", ({ name, protocol }) => {
      // Given
      const factory = vi.fn(createImplementation);

      // When
      const create = () =>
        createStoragePlugin({ name, protocol, plugin: factory });

      // Then
      expect(create).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
      expect(factory).not.toHaveBeenCalled();
    });

    it.each(["http", "https", "storage"])(
      "accepts the legacy %s protocol",
      (protocol) => {
        // Given
        const factory = vi.fn(createImplementation);

        // When
        const plugin = createStoragePlugin({
          name: "legacy",
          protocol,
          plugin: factory,
        });

        // Then
        expect(plugin.protocol).toBe(protocol);
        expect(factory).toHaveBeenCalledOnce();
      },
    );

    it.each([
      { contentLength: -1, body: new Uint8Array() },
      { contentLength: Number.MAX_SAFE_INTEGER + 1, body: new Uint8Array() },
      { contentLength: 2, body: new Uint8Array([1]) },
    ])(
      "rejects invalid put body lengths %#",
      async ({ body, contentLength }) => {
        // Given
        const plugin = createStoragePlugin({
          name: "memory",
          protocol: "memory",
          plugin: createImplementation,
        });

        // When
        const operation = plugin.put({
          key: "bundle",
          body,
          contentLength,
          context,
        });

        // Then
        await expectCode(operation, "invalid-input");
      },
    );

    it.each([
      { start: -1 },
      { start: Number.MAX_SAFE_INTEGER + 1 },
      { start: 2, end: 1 },
      { start: 0, end: -1 },
      { start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
    ])("rejects invalid inclusive ranges %#", async (range) => {
      // Given
      const plugin = createStoragePlugin({
        name: "memory",
        protocol: "memory",
        plugin: createImplementation,
      });

      // When
      const operation = plugin.get({
        context,
        storageUri: "memory://bundle",
        range,
      });

      // Then
      await expectCode(operation, "invalid-input");
    });

    it.each(["head", "get", "delete", "issueDownload"])(
      "rejects cross-protocol URI input for %s",
      async (method) => {
        // Given
        const implementation = {
          ...createImplementation(),
          async issueDownload() {
            return {
              kind: "issued" as const,
              downloadUrl: "https://example.com",
            };
          },
        };
        const plugin = createStoragePlugin({
          name: "memory",
          protocol: "memory",
          plugin: () => implementation,
        });

        // When
        const operation =
          method === "head"
            ? plugin.head({ context, storageUri: "other://bundle" })
            : method === "get"
              ? plugin.get({ context, storageUri: "other://bundle" })
              : method === "delete"
                ? plugin.delete({ context, storageUri: "other://bundle" })
                : plugin.issueDownload?.({
                    context,
                    storageUri: "other://bundle",
                  });

        // Then
        await expectCode(Promise.resolve(operation), "invalid-uri");
      },
    );

    it("accepts https locations for the http protocol", async () => {
      // Given
      const implementation: StoragePluginImplementation = {
        ...createImplementation(),
        async put() {
          return {
            kind: "stored",
            storageUri: "https://example.com/bundle",
          };
        },
      };
      const plugin = createStoragePlugin({
        name: "web",
        protocol: "http",
        plugin: () => implementation,
      });

      // When
      const result = plugin.put({
        key: "bundle",
        body: new Uint8Array(),
        contentLength: 0,
        context,
      });

      // Then
      await expect(result).resolves.toEqual({
        kind: "stored",
        storageUri: "https://example.com/bundle",
      });
    });

    it.each(["put", "head", "get"])(
      "rejects cross-protocol URI output from %s",
      async (method) => {
        // Given
        const implementation: StoragePluginImplementation = {
          ...createImplementation(),
          async put() {
            return { kind: "stored", storageUri: "other://bundle" };
          },
          async head() {
            return {
              kind: "found",
              storageUri: "other://bundle",
              metadata: { contentLength: 1 },
            };
          },
          async get() {
            return {
              kind: "found",
              storageUri: "other://bundle",
              body: new ReadableStream<Uint8Array>(),
              metadata: { contentLength: 1 },
            };
          },
        };
        const plugin = createStoragePlugin({
          name: "memory",
          protocol: "memory",
          plugin: () => implementation,
        });

        // When
        const operation =
          method === "put"
            ? plugin.put({
                key: "bundle",
                body: new Uint8Array(),
                contentLength: 0,
                context,
              })
            : method === "head"
              ? plugin.head({ context, storageUri: "memory://bundle" })
              : plugin.get({ context, storageUri: "memory://bundle" });

        // Then
        await expectCode(operation, "invalid-uri");
      },
    );
  });
};

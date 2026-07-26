import { describe, expect, it, vi } from "vitest";

import {
  materializeStorageInput,
  materializeStorageInputSync,
  normalizeStoragePlugin,
  StorageConfigurationError,
} from "./normalizeStorageInput";
import { createStoragePlugin } from "./storage";
import type { NodeStoragePlugin } from "./types";

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

const createV2Plugin = (onUnmount?: () => void | Promise<void>) =>
  createStoragePlugin({
    name: "v2",
    protocol: "v2",
    plugin: () => ({
      delete: async () => ({ kind: "deleted" }),
      get: async () => ({ kind: "not-found" }),
      head: async () => ({ kind: "not-found" }),
      onUnmount,
      put: async () => ({ kind: "stored", storageUri: "v2://bundle" }),
    }),
  });

describe("normalizeStoragePlugin", () => {
  it("preserves a direct v2 plugin identity", () => {
    // Given
    const plugin = createV2Plugin();

    // When
    const normalized = normalizeStoragePlugin(plugin);

    // Then
    expect(normalized).toEqual({ origin: "direct", plugin });
    expect(normalized.plugin).toBe(plugin);
  });

  it("preserves a direct legacy plugin identity", () => {
    // Given
    const plugin = createLegacyPlugin();

    // When
    const normalized = normalizeStoragePlugin(plugin);

    // Then
    expect(normalized).toEqual({ origin: "direct", plugin });
    expect(normalized.plugin).toBe(plugin);
  });

  it("rejects malformed materialized input with a typed error", () => {
    // Given
    const invokeWithMalformedInput = () =>
      Reflect.apply(normalizeStoragePlugin, undefined, [{ name: "invalid" }]);

    // When
    const capture = () => invokeWithMalformedInput();

    // Then
    expect(capture).toThrowError(
      expect.objectContaining({
        code: "invalid-storage-input",
        name: "StorageConfigurationError",
      }),
    );
  });
});

describe("materializeStorageInput", () => {
  it("invokes a synchronous legacy factory once per call", async () => {
    // Given
    const plugin = createLegacyPlugin();
    const factory = vi.fn(() => plugin);

    // When
    const normalized = await materializeStorageInput(factory);

    // Then
    expect(factory).toHaveBeenCalledOnce();
    expect(normalized).toEqual({ origin: "factory", plugin });
  });

  it("awaits an asynchronous legacy factory once per call", async () => {
    // Given
    const plugin = createLegacyPlugin();
    const factory = vi.fn(async () => plugin);

    // When
    const normalized = await materializeStorageInput(factory);

    // Then
    expect(factory).toHaveBeenCalledOnce();
    expect(normalized).toEqual({ origin: "factory", plugin });
  });

  it("rejects a v2 factory and closes its invalid handle once", async () => {
    // Given
    const onUnmount = vi.fn();
    const plugin = createV2Plugin(onUnmount);
    const factory = vi.fn(() => plugin);

    // When
    const result = Reflect.apply(materializeStorageInput, undefined, [factory]);

    // Then
    await expect(result).rejects.toMatchObject({
      code: "v2-factory",
      name: "StorageConfigurationError",
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("keeps the v2-factory error when invalid-handle cleanup rejects", async () => {
    // Given
    const onUnmount = vi.fn(async () => {
      throw new TypeError("cleanup failed");
    });
    const plugin = createV2Plugin(onUnmount);

    // When
    const result = Reflect.apply(materializeStorageInput, undefined, [
      () => plugin,
    ]);

    // Then
    await expect(result).rejects.toMatchObject({ code: "v2-factory" });
    expect(onUnmount).toHaveBeenCalledOnce();
  });
});

describe("materializeStorageInputSync", () => {
  it("materializes a synchronous legacy factory once", () => {
    // Given
    const plugin = createLegacyPlugin();
    const factory = vi.fn(() => plugin);

    // When
    const normalized = materializeStorageInputSync(factory);

    // Then
    expect(factory).toHaveBeenCalledOnce();
    expect(normalized).toEqual({ origin: "factory", plugin });
  });

  it("rejects a Promise result and observes its later rejection", async () => {
    // Given
    const factory = vi.fn(async (): Promise<NodeStoragePlugin> => {
      throw new TypeError("factory failed");
    });

    // When
    const capture = () => materializeStorageInputSync(factory);

    // Then
    expect(capture).toThrowError(
      expect.objectContaining({
        code: "async-server-factory",
        name: "StorageConfigurationError",
      }),
    );
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("closes a later fulfilled async handle without an unhandled rejection", async () => {
    // Given
    const onUnmount = vi.fn(async () => {
      throw new TypeError("cleanup failed");
    });
    const plugin = createLegacyPlugin(onUnmount);
    const factory = vi.fn(async () => plugin);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      // When
      const capture = () => materializeStorageInputSync(factory);

      // Then
      expect(capture).toThrowError(
        expect.objectContaining({ code: "async-server-factory" }),
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(onUnmount).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("rejects a synchronous v2 factory after observing cleanup", () => {
    // Given
    const onUnmount = vi.fn();
    const plugin = createV2Plugin(onUnmount);

    // When
    const capture = () =>
      Reflect.apply(materializeStorageInputSync, undefined, [() => plugin]);

    // Then
    expect(capture).toThrowError(
      expect.objectContaining({
        code: "v2-factory",
        name: "StorageConfigurationError",
      }),
    );
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("exports the typed configuration error constructor", () => {
    // Given / When
    const error = new StorageConfigurationError(
      "invalid-storage-input",
      "invalid",
    );

    // Then
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("invalid-storage-input");
  });
});

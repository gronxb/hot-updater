import { describe, expect, it, vi } from "vitest";

import { createStoragePlugin } from "./createStoragePlugin";
import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePluginImplementation,
  type StoragePutResult,
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
  async head() {
    return { kind: "not-found" };
  },
  async get() {
    return { kind: "not-found" };
  },
  async delete() {
    return { kind: "not-found" };
  },
});

const expectCode = async (
  operation: Promise<unknown>,
  code: StoragePluginError["code"],
) => {
  await expect(operation).rejects.toMatchObject({ code });
};

export const registerStorageV2LifecycleTests = () => {
  describe("Storage v2 provider outcomes and lifecycle", () => {
    it("rejects malformed discriminated outcomes", async () => {
      // Given
      const result: StoragePutResult = {
        kind: "stored",
        storageUri: "memory://bundle",
      };
      Object.defineProperty(result, "kind", { value: "unexpected" });
      const implementation: StoragePluginImplementation = {
        ...createImplementation(),
        async put() {
          return result;
        },
      };
      const plugin = createStoragePlugin({
        name: "memory",
        protocol: "memory",
        plugin: () => implementation,
      });

      // When
      const operation = plugin.put({
        key: "bundle",
        body: new Uint8Array(),
        contentLength: 0,
        context,
      });

      // Then
      await expectCode(operation, "provider");
    });

    it.each([
      {
        thrown: new DOMException("cancelled", "AbortError"),
        code: "aborted",
      },
      { thrown: new Error("provider failed"), code: "provider" },
    ] satisfies readonly {
      thrown: Error;
      code: StoragePluginError["code"];
    }[])("maps provider failures to $code", async ({ code, thrown }) => {
      // Given
      const implementation: StoragePluginImplementation = {
        ...createImplementation(),
        async put() {
          throw thrown;
        },
      };
      const plugin = createStoragePlugin({
        name: "memory",
        protocol: "memory",
        plugin: () => implementation,
      });

      // When
      const operation = plugin.put({
        key: "bundle",
        body: new Uint8Array(),
        contentLength: 0,
        context,
      });

      // Then
      await expectCode(operation, code);
    });

    it("preserves typed provider failures", async () => {
      // Given
      const failure = new StoragePluginError("forbidden", "denied");
      const implementation: StoragePluginImplementation = {
        ...createImplementation(),
        async delete() {
          throw failure;
        },
      };
      const plugin = createStoragePlugin({
        name: "memory",
        protocol: "memory",
        plugin: () => implementation,
      });

      // When
      const operation = plugin.delete({
        context,
        storageUri: "memory://bundle",
      });

      // Then
      await expect(operation).rejects.toBe(failure);
    });

    it.each([false, true])(
      "runs provider cleanup exactly once after success=%s",
      async (fails) => {
        // Given
        const cleanup = vi.fn(async () => {
          if (fails) {
            throw new Error("cleanup failed");
          }
        });
        const plugin = createStoragePlugin({
          name: "memory",
          protocol: "memory",
          plugin: () => ({ ...createImplementation(), onUnmount: cleanup }),
        });

        // When
        const first = plugin.onUnmount?.();
        const second = plugin.onUnmount?.();

        // Then
        if (fails) {
          await expect(first).rejects.toMatchObject({ code: "provider" });
          await expect(second).rejects.toMatchObject({ code: "provider" });
        } else {
          await expect(first).resolves.toBeUndefined();
          await expect(second).resolves.toBeUndefined();
        }
        expect(cleanup).toHaveBeenCalledOnce();
      },
    );
  });
};

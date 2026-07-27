import { describe, expect, it } from "vitest";

import {
  createStoragePlugin,
  type StorageOperationContext,
  type StoragePluginImplementation,
} from "./storage";

describe("StorageOperationContext", () => {
  it("composes one implementation into a named storage handle", async () => {
    // Given
    let factoryCalls = 0;
    const implementation: StoragePluginImplementation = {
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
    };

    // When
    const plugin = createStoragePlugin({
      name: "memory",
      protocol: "memory",
      plugin: () => {
        factoryCalls += 1;
        return implementation;
      },
    });
    const result = await plugin.put({
      key: "bundle",
      body: new Uint8Array(),
      contentLength: 0,
      context: {
        target: "node",
        environment: {},
        bindings: {},
      },
    });

    // Then
    expect(factoryCalls).toBe(1);
    expect(plugin.name).toBe("memory");
    expect(plugin.protocol).toBe("memory");
    expect(result).toEqual({
      kind: "stored",
      storageUri: "memory://bundle",
    });
  });

  it("preserves a live binding identity and state across operations", async () => {
    // Given
    const bucket = {
      value: 0,
      increment() {
        this.value += 1;
        return this.value;
      },
    };
    const bindings = Object.freeze({ bucket });
    const context: StorageOperationContext<typeof bindings> = Object.freeze({
      target: "worker",
      environment: Object.freeze({}),
      bindings,
    });
    const observedBindings: (typeof bucket)[] = [];
    const plugin: StoragePluginImplementation<typeof context> = {
      async put(input) {
        observedBindings.push(input.context.bindings.bucket);
        input.context.bindings.bucket.increment();
        return {
          kind: "stored",
          storageUri: `memory://${input.key}`,
        };
      },
      async head(input) {
        observedBindings.push(input.context.bindings.bucket);
        input.context.bindings.bucket.increment();
        return { kind: "not-found" };
      },
      async get() {
        return { kind: "not-found" };
      },
      async delete() {
        return { kind: "not-found" };
      },
    };

    // When
    await plugin.put({
      key: "bundle",
      body: new Uint8Array(),
      contentLength: 0,
      context,
    });
    await plugin.head({ context, storageUri: "memory://bundle" });

    // Then
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(Object.isFrozen(context.bindings)).toBe(true);
    expect(Object.isFrozen(bucket)).toBe(false);
    expect(observedBindings).toEqual([bucket, bucket]);
    expect(bucket.value).toBe(2);
  });
});

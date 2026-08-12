import { describe, expect, it, vi } from "vitest";

import {
  assertStorageOperations,
  createStoragePlugin,
} from "./createStoragePlugin";

describe("createStoragePlugin", () => {
  it("exposes the configured one-depth runtime-independent contract", () => {
    const put = vi.fn();
    const get = vi.fn();
    const exists = vi.fn();
    const deleteObject = vi.fn();

    const plugin = createStoragePlugin({
      name: "testStorage",
      protocol: "test",
      put,
      get,
      exists,
      delete: deleteObject,
    });

    expect(Object.keys(plugin).sort()).toEqual([
      "delete",
      "exists",
      "get",
      "name",
      "protocol",
      "put",
    ]);
    expect(plugin.put).toBe(put);
    expect(plugin.get).toBe(get);
    expect(Reflect.has(plugin, "profiles")).toBe(false);
    expect(Reflect.has(plugin, "factory")).toBe(false);
    expect(Reflect.has(plugin, "context")).toBe(false);
  });

  it("keeps capabilities optional without adding throwing placeholders", () => {
    const storage = createStoragePlugin({
      name: "cliOnlyStorage",
      protocol: "test",
      put: vi.fn(),
      exists: vi.fn(),
    });

    expect(Object.keys(storage).sort()).toEqual([
      "exists",
      "name",
      "protocol",
      "put",
    ]);
    expect(Reflect.has(storage, "delete")).toBe(false);
  });

  it("uses a streaming Web Response for runtime-independent reads", async () => {
    const storage = createStoragePlugin({
      name: "streamingStorage",
      protocol: "test",
      get: async (_storageUri: string) =>
        new Response(new TextEncoder().encode("bundle"), {
          headers: { "content-type": "application/zip" },
        }),
    });

    const response = await storage.get("test://bucket/bundle.zip");
    expect(response).toBeInstanceOf(Response);
    expect(response?.headers.get("content-type")).toBe("application/zip");
    await expect(response?.text()).resolves.toBe("bundle");
  });

  it("reports the exact capability missing from a consumer boundary", () => {
    const storage = createStoragePlugin({
      name: "cliOnlyStorage",
      protocol: "test",
      put: vi.fn(),
    });

    expect(() => assertStorageOperations(storage, ["put", "get"])).toThrow(
      'Storage plugin "cliOnlyStorage" does not implement get.',
    );
  });
});

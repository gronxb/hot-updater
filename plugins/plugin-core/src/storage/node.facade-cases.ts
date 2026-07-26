import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { StoragePluginError } from "../storage";
import type { StorageOperationContext, StoragePlugin } from "../types/storage";
import {
  createNodeStoragePluginFacade,
  type NodeStorageContextSource,
} from "./node";

type RecordedOperation = Readonly<{
  context: StorageOperationContext;
  name: "put" | "head" | "get" | "delete";
  storageUri?: string;
}>;

const createContext = (id: string): StorageOperationContext =>
  Object.freeze({
    target: "node",
    environment: Object.freeze({ id }),
    bindings: Object.freeze({}),
  });

const createRecordingPlugin = (
  operations: RecordedOperation[],
  body = new Uint8Array([4, 5, 6]),
): StoragePlugin => ({
  name: "recording",
  protocol: "memory",
  async put(input) {
    operations.push({ context: input.context, name: "put" });
    const bytes =
      input.body instanceof Uint8Array
        ? input.body
        : new Uint8Array(await new Response(input.body).arrayBuffer());
    expect(bytes.byteLength).toBe(input.contentLength);
    return { kind: "stored", storageUri: "memory://bucket/uploaded" };
  },
  async head(input) {
    operations.push({
      context: input.context,
      name: "head",
      storageUri: input.storageUri,
    });
    return input.storageUri.endsWith("/missing")
      ? { kind: "not-found" }
      : {
          kind: "found",
          storageUri: input.storageUri,
          metadata: { contentLength: body.byteLength },
        };
  },
  async get(input) {
    operations.push({
      context: input.context,
      name: "get",
      storageUri: input.storageUri,
    });
    return {
      kind: "found",
      storageUri: input.storageUri,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      metadata: { contentLength: body.byteLength },
    };
  },
  async delete(input) {
    operations.push({
      context: input.context,
      name: "delete",
      storageUri: input.storageUri,
    });
    return { kind: "deleted" };
  },
});

export const registerFacadeCases = (temporaryDirectory: () => string): void => {
  describe("createNodeStoragePluginFacade", () => {
    it("preserves upload bytes, content length, URI, and concrete context identity", async () => {
      // Given
      const operations: RecordedOperation[] = [];
      const context = createContext("concrete");
      const facade = createNodeStoragePluginFacade(
        createRecordingPlugin(operations),
        context,
      );
      const filePath = `${temporaryDirectory()}/upload.bin`;
      await writeFile(filePath, new Uint8Array([1, 2, 3, 4]));

      // When
      const result = await facade.profiles.node.upload("asset/key", filePath);

      // Then
      expect(result).toEqual({ storageUri: "memory://bucket/uploaded" });
      expect(operations).toEqual([{ context, name: "put" }]);
    });

    it("appends the source basename to the legacy prefix before v2 put", async () => {
      // Given
      const keys: string[] = [];
      const plugin: StoragePlugin = {
        ...createRecordingPlugin([]),
        async put(input) {
          keys.push(input.key);
          await new Response(input.body).arrayBuffer();
          return {
            kind: "stored",
            storageUri: `memory://bucket/${input.key}`,
          };
        },
      };
      const facade = createNodeStoragePluginFacade(
        plugin,
        createContext("basename"),
      );
      const filePath = `${temporaryDirectory()}/bundle.zip`;
      await writeFile(filePath, new Uint8Array([1, 2, 3]));

      // When
      const result = await facade.profiles.node.upload(
        "updates/bundle-id",
        filePath,
      );

      // Then
      expect(keys).toEqual(["updates/bundle-id/bundle.zip"]);
      expect(result.storageUri).toBe(
        "memory://bucket/updates/bundle-id/bundle.zip",
      );
    });

    it("does not duplicate a basename already present in the legacy key", async () => {
      // Given
      const keys: string[] = [];
      const plugin: StoragePlugin = {
        ...createRecordingPlugin([]),
        async put(input) {
          keys.push(input.key);
          await new Response(input.body).arrayBuffer();
          return { kind: "stored", storageUri: "memory://bucket/stored" };
        },
      };
      const facade = createNodeStoragePluginFacade(
        plugin,
        createContext("basename-present"),
      );
      const filePath = `${temporaryDirectory()}/manifest.json`;
      await writeFile(filePath, new Uint8Array([1]));

      // When
      await facade.profiles.node.upload(
        "updates/bundle-id/manifest.json",
        filePath,
      );

      // Then
      expect(keys).toEqual(["updates/bundle-id/manifest.json"]);
    });

    it("normalizes Windows-like separators while preserving URI key layout", async () => {
      // Given
      const keys: string[] = [];
      const plugin: StoragePlugin = {
        ...createRecordingPlugin([]),
        async put(input) {
          keys.push(input.key);
          await new Response(input.body).arrayBuffer();
          return { kind: "stored", storageUri: "memory://bucket/stored" };
        },
      };
      const facade = createNodeStoragePluginFacade(
        plugin,
        createContext("windows-path"),
      );
      const filePath = `${temporaryDirectory()}/source\\patch.bsdiff`;
      await writeFile(filePath, new Uint8Array([2]));

      // When
      await facade.profiles.node.upload(
        "updates\\bundle-id\\patches",
        filePath,
      );

      // Then
      expect(keys).toEqual(["updates/bundle-id/patches/patch.bsdiff"]);
    });

    it("maps get, head, and exact delete to legacy operations", async () => {
      // Given
      const operations: RecordedOperation[] = [];
      const context = createContext("operations");
      const facade = createNodeStoragePluginFacade(
        createRecordingPlugin(operations),
        context,
      );
      const filePath = `${temporaryDirectory()}/download.bin`;

      // When
      await facade.profiles.node.downloadFile(
        "memory://bucket/download",
        filePath,
      );
      const present = await facade.profiles.node.exists(
        "memory://bucket/download",
      );
      const missing = await facade.profiles.node.exists(
        "memory://bucket/missing",
      );
      await facade.profiles.node.delete("memory://bucket/download");

      // Then
      expect(new Uint8Array(await readFile(filePath))).toEqual(
        new Uint8Array([4, 5, 6]),
      );
      expect({ present, missing }).toEqual({ present: true, missing: false });
      expect(operations).toEqual([
        {
          context,
          name: "get",
          storageUri: "memory://bucket/download",
        },
        {
          context,
          name: "head",
          storageUri: "memory://bucket/download",
        },
        {
          context,
          name: "head",
          storageUri: "memory://bucket/missing",
        },
        {
          context,
          name: "delete",
          storageUri: "memory://bucket/download",
        },
      ]);
    });

    it("invokes a context factory once per operation without reuse", async () => {
      // Given
      const operations: RecordedOperation[] = [];
      let invocation = 0;
      const contextSource: NodeStorageContextSource = () => {
        invocation += 1;
        return createContext(String(invocation));
      };
      const facade = createNodeStoragePluginFacade(
        createRecordingPlugin(operations),
        contextSource,
      );
      const filePath = `${temporaryDirectory()}/factory-upload.bin`;
      await writeFile(filePath, new Uint8Array([9]));

      // When
      await facade.profiles.node.upload("key", filePath);
      await facade.profiles.node.exists("memory://bucket/key");
      await facade.profiles.node.delete("memory://bucket/key");

      // Then
      expect(invocation).toBe(3);
      expect(
        operations.map(({ context }) => context.environment["id"]),
      ).toEqual(["1", "2", "3"]);
      expect(new Set(operations.map(({ context }) => context)).size).toBe(3);
    });

    it("does not expose or forward underlying teardown", async () => {
      // Given
      const onUnmount = vi.fn();
      const plugin: StoragePlugin = {
        ...createRecordingPlugin([]),
        onUnmount,
      };

      // When
      const facade = createNodeStoragePluginFacade(
        plugin,
        createContext("borrowed"),
      );

      // Then
      expect("onUnmount" in facade).toBe(false);
      expect(onUnmount).not.toHaveBeenCalled();
    });

    it("rejects a non-Node context before provider I/O", async () => {
      // Given
      const operations: RecordedOperation[] = [];
      const context: StorageOperationContext = Object.freeze({
        target: "worker",
        environment: Object.freeze({}),
        bindings: Object.freeze({}),
      });
      const facade = createNodeStoragePluginFacade(
        createRecordingPlugin(operations),
        context,
      );

      // When
      const operation = facade.profiles.node.exists("memory://bucket/key");

      // Then
      await expect(operation).rejects.toEqual(
        new StoragePluginError(
          "invalid-input",
          'Node storage operations require context.target "node".',
        ),
      );
      expect(operations).toEqual([]);
    });
  });
};

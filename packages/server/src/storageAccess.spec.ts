import type {
  RuntimeStoragePlugin,
  StorageOperationContext,
  StoragePluginV2,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStorageAccess,
  createStorageCallContext,
  MAX_STORAGE_TEXT_BYTES,
} from "./storageAccess";

describe("createStorageAccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads text through a matching runtime storage plugin before direct HTTP fetch", async () => {
    const readText = vi.fn(async () => "manifest text");
    const storagePlugin: RuntimeStoragePlugin = {
      name: "httpStorage",
      supportedProtocol: "http",
      profiles: {
        runtime: {
          readText,
          async getDownloadUrl(storageUri) {
            return { fileUrl: storageUri };
          },
        },
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("should not be used", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("http://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
    expect(readText).toHaveBeenCalledWith(
      "http://assets.example.com/manifest.json",
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads direct HTTP storage text when no storage plugin owns the protocol", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("manifest text", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://assets.example.com/manifest.json",
    );
  });

  it("uses direct HTTPS fallback when only the HTTP protocol is registered", async () => {
    const readText = vi.fn(async () => "plugin");
    const storagePlugin = createRuntimeStoragePlugin(
      "standaloneStorage",
      "http",
      {
        readText,
      },
    );
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("direct", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("direct");
    expect(readText).not.toHaveBeenCalled();
  });

  it("uses an explicitly registered HTTPS plugin before direct fetch", async () => {
    const readText = vi.fn(async () => "plugin");
    const storagePlugin = createRuntimeStoragePlugin("httpsStorage", "https", {
      readText,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("plugin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate normalized protocols before the first storage operation", () => {
    const firstRead = vi.fn(async () => "first");
    const secondRead = vi.fn(async () => "second");
    const first = createRuntimeStoragePlugin("standaloneStorage", "HTTP", {
      readText: firstRead,
    });
    const second = createRuntimeStoragePlugin("proxyStorage", "http", {
      readText: secondRead,
    });

    expect(() => createStorageAccess([first, second])).toThrow(
      'Duplicate storage protocol "http" from plugins "standaloneStorage" and "proxyStorage".',
    );
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
  });

  it("rejects malformed storage URIs deterministically", async () => {
    const { readStorageText } = createStorageAccess([]);

    await expect(readStorageText("not a storage URI")).rejects.toThrow(
      "Invalid storage URI: not a storage URI",
    );
  });

  it("rejects storage URIs owned by an unregistered provider", async () => {
    const storagePlugin = createRuntimeStoragePlugin("r2Storage", "r2");
    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("s3://release-bucket/updates/bundle.zip"),
    ).rejects.toThrow("No storage plugin for protocol: s3");
  });

  it("reads v2 UTF-8 text with the exact supplied context", async () => {
    // Given
    const context: StorageOperationContext = Object.freeze({
      target: "edge",
      environment: Object.freeze({}),
      bindings: Object.freeze({ requestId: "one" }),
    });
    const get = vi.fn<StoragePluginV2["get"]>(async ({ storageUri }) => ({
      kind: "found",
      storageUri,
      body: new Blob(["manifest"]).stream(),
      metadata: { contentLength: 8 },
    }));
    const access = createStorageAccess([createV2Storage(get)]);

    // When
    const text = access.readStorageText(
      "storage://manifest",
      createStorageCallContext(undefined, context),
    );

    // Then
    await expect(text).resolves.toBe("manifest");
    expect(get).toHaveBeenCalledWith({
      context,
      storageUri: "storage://manifest",
    });
  });

  it("releases a declared oversized v2 stream after cancelling it", async () => {
    // Given
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const access = createStorageAccess([
      createV2Storage(async ({ storageUri }) => ({
        kind: "found",
        storageUri,
        body: stream,
        metadata: { contentLength: 1024 * 1024 + 1 },
      })),
    ]);

    // When
    const text = access.readStorageText(
      "storage://manifest",
      createStorageCallContext(
        undefined,
        Object.freeze({
          target: "node",
          environment: Object.freeze({}),
          bindings: Object.freeze({}),
        }),
      ),
    );

    // Then
    await expect(text).rejects.toThrow(
      "Storage text exceeds the maximum size.",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects an actual oversized v2 stream without cancelling it twice", async () => {
    // Given
    let underlyingCancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_STORAGE_TEXT_BYTES + 1));
      },
      cancel() {
        underlyingCancelCalls += 1;
      },
    });
    const nativeCancel = ReadableStreamDefaultReader.prototype.cancel;
    const cancel = vi
      .spyOn(ReadableStreamDefaultReader.prototype, "cancel")
      .mockImplementation(function (
        this: ReadableStreamDefaultReader<Uint8Array>,
        reason?: unknown,
      ) {
        if (cancel.mock.calls.length > 1) {
          return Promise.reject(new Error("second cancellation rejected"));
        }
        return nativeCancel.call(this, reason);
      });
    const access = createStorageAccess([
      createV2Storage(async ({ storageUri }) => ({
        kind: "found",
        storageUri,
        body: stream,
        metadata: { contentLength: 1 },
      })),
    ]);

    // When
    const text = access.readStorageText(
      "storage://manifest",
      createStorageCallContext(
        undefined,
        Object.freeze({
          target: "node",
          environment: Object.freeze({}),
          bindings: Object.freeze({}),
        }),
      ),
    );

    // Then
    await expect(text).rejects.toThrow(
      "Storage text exceeds the maximum size.",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(underlyingCancelCalls).toBe(1);
    expect(stream.locked).toBe(false);
  });

  it("cancels a v2 stream when UTF-8 decoding fails", async () => {
    // Given
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(Uint8Array.of(0xff));
      },
    });
    const access = createStorageAccess([
      createV2Storage(async ({ storageUri }) => ({
        kind: "found",
        storageUri,
        body: stream,
        metadata: { contentLength: 1 },
      })),
    ]);

    // When
    const text = access.readStorageText(
      "storage://manifest",
      createStorageCallContext(
        undefined,
        Object.freeze({
          target: "edge",
          environment: Object.freeze({}),
          bindings: Object.freeze({}),
        }),
      ),
    );

    // Then
    await expect(text).rejects.toBeInstanceOf(TypeError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const createRuntimeStoragePlugin = (
  name: string,
  supportedProtocol: string,
  overrides: Partial<RuntimeStoragePlugin["profiles"]["runtime"]> = {},
): RuntimeStoragePlugin => ({
  name,
  supportedProtocol,
  profiles: {
    runtime: {
      async getDownloadUrl(storageUri) {
        return { fileUrl: storageUri };
      },
      async readText() {
        return null;
      },
      ...overrides,
    },
  },
});

const createV2Storage = (get: StoragePluginV2["get"]): StoragePluginV2 => ({
  name: "v2Storage",
  protocol: "storage",
  async put() {
    throw new Error("unused");
  },
  async head() {
    return { kind: "not-found" };
  },
  get,
  async delete() {
    return { kind: "not-found" };
  },
});

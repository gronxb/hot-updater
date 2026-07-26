import {
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { storageConformanceAssertions } from "@hot-updater/test-utils/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage as edgeStorage } from "./edge";
import { createEdgeStorageContext } from "./edgeContext";
import { supabaseStorage as nodeStorage } from "./node";
import { SupabaseStorageHttpFake } from "./supabaseStorageV2.test-support";

const nodeContext = (environment: Readonly<Record<string, string>> = {}) =>
  Object.freeze({
    target: "node",
    environment: Object.freeze({ ...environment }),
    bindings: Object.freeze({}),
  }) satisfies StorageOperationContext;

const assertSupportedConformance = async (
  plugin: StoragePlugin,
  context: StorageOperationContext,
): Promise<void> => {
  await storageConformanceAssertions.byteRoundTrip(plugin, context);
  await storageConformanceAssertions.streamRoundTrip(plugin, context);
  await storageConformanceAssertions.atomicCreateOnly(plugin, context);
  await storageConformanceAssertions.inclusiveRangeAndMetadata(plugin, context);
  await storageConformanceAssertions.headAndNotFound(plugin, context);
  await storageConformanceAssertions.exactIdempotentDelete(plugin, context);
  await storageConformanceAssertions.cancellationCancelsInputStream(
    plugin,
    context,
  );
  await storageConformanceAssertions.uriValidation(plugin, context);
  await storageConformanceAssertions.unmountIsIdempotent(plugin, context);
};

describe("Supabase Storage v2", () => {
  const fake = new SupabaseStorageHttpFake();

  afterEach(() => {
    vi.unstubAllGlobals();
    fake.reset();
  });

  it.each([
    ["node", nodeStorage, nodeContext()],
    [
      "worker",
      edgeStorage,
      createEdgeStorageContext({
        target: "worker",
        environment: {},
        bindings: {},
      }),
    ],
    [
      "edge",
      edgeStorage,
      createEdgeStorageContext({
        target: "edge",
        environment: {},
        bindings: {},
      }),
    ],
  ] as const)(
    "passes supported conformance under %s",
    async (_, factory, context) => {
      vi.stubGlobal("fetch", fake.fetch);
      const plugin = factory({
        bucketName: "updates",
        supabaseServiceRoleKey: "key",
        supabaseUrl: "https://project.example",
      });

      await assertSupportedConformance(plugin, context);
    },
  );

  it.each(["node", "functions"] as const)(
    "rejects %s contexts on the Edge entry before I/O",
    async (target) => {
      vi.stubGlobal("fetch", fake.fetch);
      const plugin = edgeStorage({
        bucketName: "updates",
        supabaseServiceRoleKey: "key",
        supabaseUrl: "https://project.example",
      });
      const context = Object.freeze({
        target,
        environment: Object.freeze({}),
        bindings: Object.freeze({}),
      });

      await expect(
        plugin.head({
          context,
          storageUri: "supabase-storage://updates/item",
        }),
      ).rejects.toMatchObject({
        code: "invalid-input",
        name: "StoragePluginError",
      });
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("preserves basePath URIs and supports signed and public delivery", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const context = nodeContext();
    const signed = nodeStorage({
      basePath: "/releases/",
      bucketName: "updates",
      signedUrlExpiresIn: 60,
      supabaseServiceRoleKey: "key",
      supabaseUrl: "https://project.example",
    });
    const stored = await signed.put({
      context,
      key: "/bundle.zip",
      body: new Uint8Array([1]),
      contentLength: 1,
    });
    expect(stored).toEqual({
      kind: "stored",
      storageUri: "supabase-storage://updates/releases/bundle.zip",
    });
    await expect(
      signed.issueDownload?.({ context, storageUri: stored.storageUri }),
    ).resolves.toMatchObject({
      kind: "issued",
      downloadUrl: "https://project.example/signed/releases/bundle.zip",
    });

    const publicStorage = nodeStorage({
      bucketName: "public",
      delivery: "public",
      supabaseServiceRoleKey: "key",
      supabaseUrl: "https://project.example",
    });
    await expect(
      publicStorage.issueDownload?.({
        context,
        storageUri: "supabase-storage://public/item",
      }),
    ).resolves.toEqual({
      kind: "issued",
      downloadUrl:
        "https://project.example/storage/v1/object/public/public/item",
    });
  });

  it("rejects malformed info and propagates output stream cancellation", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const context = nodeContext();
    const plugin = nodeStorage({
      bucketName: "updates",
      supabaseServiceRoleKey: "key",
      supabaseUrl: "https://project.example",
    });
    await plugin.put({
      context,
      key: "item",
      body: new Uint8Array([0]),
      contentLength: 1,
    });
    fake.setMalformedInfo(true);
    await expect(
      plugin.head({
        context,
        storageUri: "supabase-storage://updates/item",
      }),
    ).rejects.toMatchObject({ code: "provider" });

    fake.setMalformedInfo(false);
    await plugin.put({
      context,
      key: "cancel",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    fake.setKeepOutputOpen(true);
    const result = await plugin.get({
      context,
      storageUri: "supabase-storage://updates/cancel",
    });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      await result.body.cancel();
    }
    expect(fake.outputCancelled).toBe(true);
  });
});

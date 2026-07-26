import { binding } from "@hot-updater/core/config";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { setupStoragePluginTestSuite } from "@hot-updater/test-utils/storage";
import { describe, expect, it } from "vitest";

import { r2Storage } from "./worker";
import { createWorkerStorageContext } from "./workerContext";

type StoredObject = Readonly<{
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Readonly<Record<string, string>>;
}>;

const createBucket = (label: string) => {
  const objects = new Map<string, StoredObject>();
  const calls: string[] = [];
  return {
    calls,
    async delete(key: string) {
      calls.push(`${label}:delete:${key}`);
      objects.delete(key);
    },
    async get(
      key: string,
      options?: Readonly<{
        range?: Readonly<{ offset: number; length?: number }>;
      }>,
    ) {
      calls.push(`${label}:get:${key}`);
      const object = objects.get(key);
      if (object === undefined) {
        return null;
      }
      const start = options?.range?.offset ?? 0;
      const end =
        options?.range?.length === undefined
          ? object.bytes.byteLength
          : start + options.range.length;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.bytes.slice(start, end));
            controller.close();
          },
        }),
        customMetadata: object.customMetadata,
        etag: `${label}-etag`,
        httpMetadata: { contentType: object.contentType },
        key,
        size: object.bytes.byteLength,
        uploaded: new Date("2026-01-01T00:00:00.000Z"),
      };
    },
    async head(key: string) {
      calls.push(`${label}:head:${key}`);
      const object = objects.get(key);
      if (object === undefined) {
        return null;
      }
      return {
        customMetadata: object.customMetadata,
        etag: `${label}-etag`,
        httpMetadata: { contentType: object.contentType },
        key,
        size: object.bytes.byteLength,
        uploaded: new Date("2026-01-01T00:00:00.000Z"),
      };
    },
    async put(
      key: string,
      value: Uint8Array | ReadableStream<Uint8Array>,
      options?: Readonly<{
        customMetadata?: Readonly<Record<string, string>>;
        httpMetadata?: Readonly<{ contentType?: string }>;
        onlyIf?: Readonly<{ etagDoesNotMatch?: string }>;
      }>,
    ) {
      calls.push(`${label}:put:${key}`);
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        return null;
      }
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType,
        customMetadata: options?.customMetadata,
      });
      return {
        etag: `${label}-etag`,
        key,
        size: bytes.byteLength,
        uploaded: new Date("2026-01-01T00:00:00.000Z"),
      };
    },
  };
};

const conformanceBucket = createBucket("conformance");
const conformanceContext = createWorkerStorageContext({
  environment: {},
  bindings: { BUCKET: conformanceBucket },
});

setupStoragePluginTestSuite({
  name: "Cloudflare R2 Worker Storage v2 conformance",
  context: conformanceContext,
  createPlugin: () =>
    r2Storage({
      bucket: binding("BUCKET"),
      bucketName: "conformance",
    }),
});

describe("worker r2Storage v2", () => {
  it("isolates concurrent operations by their current binding", async () => {
    // Given
    const bucketA = createBucket("A");
    const bucketB = createBucket("B");
    const storage = r2Storage({
      basePath: "releases",
      bucket: binding("BUCKET"),
      bucketName: "bundles",
    });
    const contextA = createWorkerStorageContext({
      environment: {},
      bindings: { BUCKET: bucketA },
    });
    const contextB = createWorkerStorageContext({
      environment: {},
      bindings: { BUCKET: bucketB },
    });

    // When
    const results = await Promise.all([
      storage.put({
        body: new Uint8Array([1]),
        contentLength: 1,
        context: contextA,
        key: "app/a",
      }),
      storage.put({
        body: new Uint8Array([2]),
        contentLength: 1,
        context: contextB,
        key: "app/b",
      }),
    ]);

    // Then
    expect(results).toEqual([
      { kind: "stored", storageUri: "r2://bundles/releases/app/a" },
      { kind: "stored", storageUri: "r2://bundles/releases/app/b" },
    ]);
    expect(bucketA.calls).toEqual(["A:put:releases/app/a"]);
    expect(bucketB.calls).toEqual(["B:put:releases/app/b"]);
  });

  it("returns create-only conflicts without replacing the object", async () => {
    // Given
    const bucket = createBucket("A");
    const storage = r2Storage({
      bucket: binding("BUCKET"),
      bucketName: "bundles",
    });
    const context = createWorkerStorageContext({
      environment: {},
      bindings: { BUCKET: bucket },
    });

    // When
    const outcomes = await Promise.all([
      storage.put({
        body: new Uint8Array([1]),
        condition: "create-only",
        contentLength: 1,
        context,
        key: "atomic",
      }),
      storage.put({
        body: new Uint8Array([2]),
        condition: "create-only",
        contentLength: 1,
        context,
        key: "atomic",
      }),
    ]);

    // Then
    expect(outcomes.map((result) => result.kind).sort()).toEqual([
      "already-exists",
      "stored",
    ]);
  });

  it("maps a missing or wrong binding to a redacted configuration error", async () => {
    // Given
    const canary = "seeded-secret-must-not-leak";
    const storage = r2Storage({
      bucket: binding("BUCKET"),
      bucketName: "bundles",
    });
    const context = createWorkerStorageContext({
      environment: { SECRET: canary },
      bindings: { BUCKET: { get: "wrong" } },
    });

    // When
    const outcome = storage.head({
      context,
      storageUri: "r2://bundles/item",
    });

    // Then
    await expect(outcome).rejects.toMatchObject({
      code: "invalid-input",
    } satisfies Partial<StoragePluginError>);
    await expect(outcome).rejects.not.toThrow(canary);
  });
});

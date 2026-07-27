import { binding } from "../../packages/core/src/config";
import type {
  StorageOperationContext,
  StoragePlugin,
} from "../../plugins/plugin-core/src/storage";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

type StoredObject = Readonly<{ bytes: Uint8Array }>;
type WorkerStorageModule = Readonly<{
  createWorkerStorageContext: (input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly bindings: Readonly<Record<string, unknown>>;
  }) => StorageOperationContext;
  r2Storage: (config: {
    readonly bucket: unknown;
    readonly bucketName: string;
  }) => StoragePlugin;
}>;

const isWorkerStorageModule = (value: unknown): value is WorkerStorageModule =>
  typeof value === "object" &&
  value !== null &&
  "createWorkerStorageContext" in value &&
  typeof value.createWorkerStorageContext === "function" &&
  "r2Storage" in value &&
  typeof value.r2Storage === "function";

const createBucket = (origin: "A" | "B") => {
  const objects = new Map<string, StoredObject>();
  const calls: string[] = [];
  return {
    calls,
    objects,
    async put(key: string, value: Uint8Array | ReadableStream<Uint8Array>) {
      calls.push(`${origin}:put:${key}`);
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes });
      return {
        etag: `${origin}-etag`,
        key,
        size: bytes.byteLength,
        uploaded: new Date(0),
      };
    },
    async head(key: string) {
      calls.push(`${origin}:head:${key}`);
      const object = objects.get(key);
      return object === undefined
        ? null
        : {
            etag: `${origin}-etag`,
            key,
            size: object.bytes.byteLength,
            uploaded: new Date(0),
          };
    },
    async get(key: string) {
      calls.push(`${origin}:get:${key}`);
      const object = objects.get(key);
      return object === undefined
        ? null
        : {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(object.bytes);
                controller.close();
              },
            }),
            etag: `${origin}-etag`,
            key,
            size: object.bytes.byteLength,
            uploaded: new Date(0),
          };
    },
    async delete(key: string) {
      calls.push(`${origin}:delete:${key}`);
      objects.delete(key);
    },
  };
};

export const observeCloudflareWorker =
  async (): Promise<ProviderMatrixObservation> => {
    const moduleUrl = new URL(
      "../../plugins/cloudflare/src/storage/worker.ts",
      import.meta.url,
    ).href;
    const loaded: unknown = await import(moduleUrl);
    if (!isWorkerStorageModule(loaded)) {
      throw new TypeError("Cloudflare Worker public entry is invalid.");
    }
    const { createWorkerStorageContext, r2Storage } = loaded;
    const bucketA = createBucket("A");
    const bucketB = createBucket("B");
    const bindings = [bucketA, bucketB, bucketA] as const;
    const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
      createWorkerStorageContext({
        environment: { REQUEST_ID: requestId },
        bindings: { BUCKET: bindings[index] },
      }),
    );
    const plugin = r2Storage({
      bucket: binding("BUCKET"),
      bucketName: "matrix",
    });
    const stored = await Promise.all(
      contexts.map((context, index) =>
        plugin.put({
          context,
          key: `${REQUIRED_CONTEXTS[index]}/${REQUIRED_ORIGINS[index]}-${index}`,
          body: new Uint8Array([index + 1]),
          contentLength: 1,
        }),
      ),
    );
    const firstUri = stored[0]?.storageUri ?? "";
    await plugin.head({ context: contexts[0], storageUri: firstUri });
    const found = await plugin.get({
      context: contexts[0],
      storageUri: firstUri,
    });
    if (found.kind === "found") {
      await new Response(found.body).arrayBuffer();
    }
    await plugin.delete({ context: contexts[0], storageUri: firstUri });

    return {
      id: "cloudflare-worker",
      entry: "@hot-updater/cloudflare/storage/worker",
      targets: ["worker"],
      contexts: REQUIRED_CONTEXTS,
      operations: REQUIRED_OPERATIONS,
      origins: REQUIRED_ORIGINS,
      providerVisible: {
        bindingIdentityAStable: bindings[0] === bindings[2],
        bindingIdentityDistinct: bindings[0] !== bindings[1],
        bucketACalls: bucketA.calls,
        bucketBCalls: bucketB.calls,
        bucketAObjectCount: bucketA.objects.size,
        bucketBObjectCount: bucketB.objects.size,
        streamed: found.kind === "found",
      },
      cache: { literal: "allowed", tagged: "forbidden" },
      streamLifetime: "borrowed",
      secretCanaryLeaked: false,
    };
  };

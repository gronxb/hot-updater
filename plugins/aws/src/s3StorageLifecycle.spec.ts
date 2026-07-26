import { S3Client } from "@aws-sdk/client-s3";
import { env, secret } from "@hot-updater/core/config";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { setupS3AbortLifecycleTests } from "./s3StorageAbortLifecycle.cases";
import { s3Storage } from "./storage/node";
import { startS3TestServer, type S3TestServer } from "./storage/s3TestServer";
import { retainClientThroughStream } from "./storage/stream";

const credentials = {
  accessKeyId: "literal-access-key",
  secretAccessKey: "literal-secret-key",
} as const;
const context = createNodeStorageContext({ environment: {} });
let server: S3TestServer | undefined;

const getServer = (): S3TestServer => {
  if (server === undefined) {
    throw new TypeError("S3 test server is not running.");
  }
  return server;
};

beforeAll(async () => {
  server = await startS3TestServer();
});

beforeEach(() => {
  getServer().cancelledStreams.length = 0;
  getServer().objects.clear();
  getServer().requests.length = 0;
  vi.clearAllMocks();
});

afterAll(async () => {
  await getServer().close();
  server = undefined;
});

describe("AWS S3 Storage v2 context isolation", () => {
  it("isolates tagged A to B to A endpoints and credentials", async () => {
    // Given
    const secondServer = await startS3TestServer();
    const plugin = s3Storage({
      bucketName: env("BUCKET"),
      endpoint: env("ENDPOINT"),
      region: "us-east-1",
      credentials: {
        accessKeyId: env("ACCESS_KEY"),
        secretAccessKey: secret("SECRET_KEY"),
      },
      forcePathStyle: true,
      maxAttempts: 1,
    });
    const first = createNodeStorageContext({
      environment: {
        BUCKET: "bucket-a",
        ENDPOINT: getServer().endpoint,
        ACCESS_KEY: "access-a",
        SECRET_KEY: "secret-a",
      },
    });
    const second = createNodeStorageContext({
      environment: {
        BUCKET: "bucket-b",
        ENDPOINT: secondServer.endpoint,
        ACCESS_KEY: "access-b",
        SECRET_KEY: "secret-b",
      },
    });

    // When
    await plugin.put({
      context: first,
      key: "a-first",
      body: new Uint8Array([1]),
      contentLength: 1,
    });
    await plugin.put({
      context: second,
      key: "b",
      body: new Uint8Array([2]),
      contentLength: 1,
    });
    await plugin.put({
      context: first,
      key: "a-second",
      body: new Uint8Array([3]),
      contentLength: 1,
    });

    // Then
    expect([...getServer().objects.keys()]).toEqual(["a-first", "a-second"]);
    expect([...secondServer.objects.keys()]).toEqual(["b"]);
    expect(
      getServer().requests.every((request) =>
        request.authorization?.includes("Credential=access-a/"),
      ),
    ).toBe(true);
    expect(
      secondServer.requests.every((request) =>
        request.authorization?.includes("Credential=access-b/"),
      ),
    ).toBe(true);
    await secondServer.close();
  });

  it("keeps concurrent tagged contexts isolated", async () => {
    // Given
    const secondServer = await startS3TestServer();
    const plugin = s3Storage({
      bucketName: env("BUCKET"),
      endpoint: env("ENDPOINT"),
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    const contexts = [
      createNodeStorageContext({
        environment: {
          BUCKET: "bucket-a",
          ENDPOINT: getServer().endpoint,
        },
      }),
      createNodeStorageContext({
        environment: {
          BUCKET: "bucket-b",
          ENDPOINT: secondServer.endpoint,
        },
      }),
    ] as const;

    // When
    await Promise.all(
      contexts.map((operationContext, index) =>
        plugin.put({
          context: operationContext,
          key: `object-${index}`,
          body: new Uint8Array([index]),
          contentLength: 1,
        }),
      ),
    );

    // Then
    expect(getServer().objects.has("object-0")).toBe(true);
    expect(secondServer.objects.has("object-1")).toBe(true);
    await secondServer.close();
  });
});

describe("AWS S3 Storage v2 lifecycle", () => {
  it("caches a literal client and destroys it exactly once", async () => {
    // Given
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const plugin = s3Storage({
      bucketName: "storage-v2",
      endpoint: getServer().endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });

    // When
    await plugin.head({
      context,
      storageUri: "s3://storage-v2/missing-a",
    });
    await plugin.head({
      context,
      storageUri: "s3://storage-v2/missing-b",
    });
    const firstCleanup = plugin.onUnmount?.();
    const secondCleanup = plugin.onUnmount?.();
    await Promise.all([firstCleanup, secondCleanup]);

    // Then
    expect(firstCleanup).toBe(secondCleanup);
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  it("retains a tagged client until its returned stream closes", async () => {
    // Given
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const plugin = s3Storage({
      bucketName: env("BUCKET"),
      endpoint: env("ENDPOINT"),
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    const taggedContext = createNodeStorageContext({
      environment: {
        BUCKET: "storage-v2",
        ENDPOINT: getServer().endpoint,
      },
    });
    await plugin.put({
      context: taggedContext,
      key: "stream",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    destroy.mockClear();

    // When
    const result = await plugin.get({
      context: taggedContext,
      storageUri: "s3://storage-v2/stream",
    });

    // Then
    expect(destroy).not.toHaveBeenCalled();
    if (result.kind === "found") {
      const bytes = new Uint8Array(
        await new Response(result.body).arrayBuffer(),
      );
      expect([...bytes]).toEqual([1, 2, 3]);
    }
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  setupS3AbortLifecycleTests(getServer);

  it.each(["cancel", "error"] as const)(
    "releases a streamed client once on %s",
    async (settlement) => {
      // Given
      const release = vi.fn();
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (settlement === "error") {
            controller.error(new Error("stream failed"));
          }
        },
      });
      const stream = retainClientThroughStream(source, release);
      const reader = stream.getReader();

      // When
      if (settlement === "cancel") {
        await reader.cancel();
      } else {
        await expect(reader.read()).rejects.toThrow("stream failed");
      }

      // Then
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});

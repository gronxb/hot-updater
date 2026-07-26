import { S3Client } from "@aws-sdk/client-s3";
import { env, secret } from "@hot-updater/core/config";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import {
  setupStoragePluginTestRunner,
  storageConformanceAssertions,
} from "@hot-updater/test-utils/storage";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import {
  startS3TestServer,
  type S3TestServer,
} from "../../../aws/src/storage/s3TestServer";
import { r2Storage } from "./node";

const credentials = {
  accessKeyId: "literal-access-key",
  secretAccessKey: "literal-secret-key",
} as const;
const context = createNodeStorageContext({ environment: {} });

let server: S3TestServer | undefined;

const getServer = (): S3TestServer => {
  if (server === undefined) {
    throw new TypeError("R2 test server is not running.");
  }
  return server;
};

beforeAll(async () => {
  server = await startS3TestServer();
});

beforeEach(() => {
  getServer().objects.clear();
  getServer().requests.length = 0;
});

afterAll(async () => {
  await getServer().close();
  server = undefined;
});

setupStoragePluginTestRunner(
  {
    name: "Cloudflare R2 Node Storage v2 conformance",
    context,
    createPlugin: () =>
      r2Storage({
        accountId: "account",
        bucketName: "storage-v2",
        credentials,
        endpoint: getServer().endpoint,
      }),
  },
  ({ context: testContext, getPlugin }) => {
    it("byte-round-trip", async () => {
      await storageConformanceAssertions.byteRoundTrip(
        getPlugin(),
        testContext,
      );
    });
    it("stream-round-trip", async () => {
      await storageConformanceAssertions.streamRoundTrip(
        getPlugin(),
        testContext,
      );
    });
    it("atomic-create-only", async () => {
      await storageConformanceAssertions.atomicCreateOnly(
        getPlugin(),
        testContext,
      );
    });
    it("inclusive-range-and-metadata", async () => {
      await storageConformanceAssertions.inclusiveRangeAndMetadata(
        getPlugin(),
        testContext,
      );
    });
    it("head-and-not-found", async () => {
      await storageConformanceAssertions.headAndNotFound(
        getPlugin(),
        testContext,
      );
    });
    it("exact-idempotent-delete", async () => {
      await storageConformanceAssertions.exactIdempotentDelete(
        getPlugin(),
        testContext,
      );
    });
    it("cancellation-cancels-input-stream", async () => {
      await storageConformanceAssertions.cancellationCancelsInputStream(
        getPlugin(),
        testContext,
      );
    });
    it("uri-validation", async () => {
      await storageConformanceAssertions.uriValidation(
        getPlugin(),
        testContext,
      );
    });
    it("unmount-is-idempotent", async () => {
      await storageConformanceAssertions.unmountIsIdempotent(
        getPlugin(),
        testContext,
      );
    });
  },
);

it("isolates tagged A to B to A endpoints and credentials", async () => {
  // Given
  const secondServer = await startS3TestServer();
  const plugin = r2Storage({
    accountId: env("ACCOUNT"),
    bucketName: env("BUCKET"),
    credentials: {
      accessKeyId: env("ACCESS_KEY"),
      secretAccessKey: secret("SECRET_KEY"),
    },
    endpoint: env("ENDPOINT"),
  });
  const contexts = [
    createNodeStorageContext({
      environment: {
        ACCOUNT: "account-a",
        BUCKET: "bucket-a",
        ENDPOINT: getServer().endpoint,
        ACCESS_KEY: "access-a",
        SECRET_KEY: "secret-a",
      },
    }),
    createNodeStorageContext({
      environment: {
        ACCOUNT: "account-b",
        BUCKET: "bucket-b",
        ENDPOINT: secondServer.endpoint,
        ACCESS_KEY: "access-b",
        SECRET_KEY: "secret-b",
      },
    }),
  ] as const;

  // When
  for (const [operationContext, key] of [
    [contexts[0], "a-first"],
    [contexts[1], "b"],
    [contexts[0], "a-second"],
  ] as const) {
    await plugin.put({
      body: new Uint8Array([1]),
      contentLength: 1,
      context: operationContext,
      key,
    });
  }

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
  await plugin.onUnmount?.();
  await secondServer.close();
});

it("caches only literal clients and destroys the cached client once", async () => {
  // Given
  const destroy = vi.spyOn(S3Client.prototype, "destroy");
  const plugin = r2Storage({
    accountId: "account",
    bucketName: "storage-v2",
    credentials,
    endpoint: getServer().endpoint,
  });

  // When
  await plugin.head({
    context,
    storageUri: "r2://storage-v2/missing-a",
  });
  await plugin.head({
    context,
    storageUri: "r2://storage-v2/missing-b",
  });
  const first = plugin.onUnmount?.();
  const second = plugin.onUnmount?.();
  await Promise.all([first, second]);

  // Then
  expect(first).toBe(second);
  expect(destroy).toHaveBeenCalledTimes(1);
  destroy.mockRestore();
});

it("retains a tagged client until the returned stream closes", async () => {
  // Given
  const destroy = vi.spyOn(S3Client.prototype, "destroy");
  const plugin = r2Storage({
    accountId: "account",
    bucketName: "storage-v2",
    credentials,
    endpoint: env("ENDPOINT"),
  });
  const taggedContext = createNodeStorageContext({
    environment: { ENDPOINT: getServer().endpoint },
  });
  await plugin.put({
    body: new Uint8Array([1, 2, 3]),
    contentLength: 3,
    context: taggedContext,
    key: "stream-lifetime",
  });
  destroy.mockClear();

  // When
  const result = await plugin.get({
    context: taggedContext,
    storageUri: "r2://storage-v2/stream-lifetime",
  });

  // Then
  expect(result.kind).toBe("found");
  expect(destroy).not.toHaveBeenCalled();
  if (result.kind === "found") {
    await new Response(result.body).arrayBuffer();
  }
  expect(destroy).toHaveBeenCalledTimes(1);
  destroy.mockRestore();
});

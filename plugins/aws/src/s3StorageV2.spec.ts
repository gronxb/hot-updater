import { S3Client } from "@aws-sdk/client-s3";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { setupStoragePluginTestSuite } from "@hot-updater/test-utils/storage";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { s3Storage as lambdaS3Storage } from "./storage/lambda";
import { createLambdaStorageContext } from "./storage/lambdaContext";
import { s3Storage } from "./storage/node";
import { startS3TestServer, type S3TestServer } from "./storage/s3TestServer";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://s3.example.test/signed"),
}));
vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://cdn.example.test/signed"),
}));

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
  getServer().objects.clear();
  getServer().requests.length = 0;
  vi.clearAllMocks();
});

afterAll(async () => {
  await getServer().close();
  server = undefined;
});

setupStoragePluginTestSuite({
  name: "AWS S3 Storage v2 conformance",
  context,
  createPlugin: () =>
    s3Storage({
      bucketName: "storage-v2",
      endpoint: getServer().endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
});

const expectCode = async (
  operation: Promise<unknown>,
  code: StoragePluginError["code"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({
    name: "StoragePluginError",
    code,
  });
};

describe("AWS S3 Storage v2 target behavior", () => {
  it("creates a frozen Lambda context without cloning binding values", () => {
    // Given
    const bindingValue = { mutable: true };

    // When
    const lambdaContext = createLambdaStorageContext({
      environment: { STAGE: "test" },
      bindings: { LIVE: bindingValue },
    });

    // Then
    expect(lambdaContext).toEqual({
      target: "functions",
      environment: { STAGE: "test" },
      bindings: { LIVE: bindingValue },
    });
    expect(Object.isFrozen(lambdaContext)).toBe(true);
    expect(Object.isFrozen(lambdaContext.environment)).toBe(true);
    expect(Object.isFrozen(lambdaContext.bindings)).toBe(true);
    expect(lambdaContext.bindings.LIVE).toBe(bindingValue);
    expect(Object.isFrozen(bindingValue)).toBe(false);
  });

  it("rejects a wrong target before S3 I/O", async () => {
    // Given
    const plugin = lambdaS3Storage({
      bucketName: "storage-v2",
      endpoint: getServer().endpoint,
      region: "us-east-1",
      credentials,
    });

    // When
    const operation = plugin.head({
      context,
      storageUri: "s3://storage-v2/object",
    });

    // Then
    await expectCode(operation, "invalid-input");
    expect(getServer().requests).toHaveLength(0);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [500, "provider"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    // Given
    const plugin = s3Storage({
      bucketName: "storage-v2",
      endpoint: getServer().endpoint,
      region: "us-east-1",
      credentials,
      maxAttempts: 1,
    });

    // When
    const operation = plugin.head({
      context,
      storageUri: `s3://storage-v2/errors/${status}`,
    });

    // Then
    await expectCode(operation, code);
    await plugin.onUnmount?.();
  });

  it("maps an SDK AbortError to aborted", async () => {
    // Given
    const send = vi.spyOn(S3Client.prototype, "send");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    send.mockRejectedValueOnce(abortError);
    const plugin = s3Storage({
      bucketName: "storage-v2",
      region: "us-east-1",
      credentials,
    });

    // When
    const operation = plugin.head({
      context,
      storageUri: "s3://storage-v2/object",
    });

    // Then
    await expectCode(operation, "aborted");
    await plugin.onUnmount?.();
    send.mockRestore();
  });
});

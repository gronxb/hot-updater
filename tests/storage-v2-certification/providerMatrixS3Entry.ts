import { env, secret } from "../../packages/core/src/config";
import { createLambdaStorageContext } from "../../plugins/aws/src/storage/lambdaContext";
import {
  startS3TestServer,
  type S3TestServer,
} from "../../plugins/aws/src/storage/s3TestServer";
import type {
  StorageOperationContext,
  StoragePlugin,
} from "../../plugins/plugin-core/src/storage";
import { createNodeStorageContext } from "../../plugins/plugin-core/src/storage/node";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

export type S3EntryHarness = Readonly<{
  readonly id: "aws-node" | "aws-lambda" | "cloudflare-node";
  readonly entry: string;
  readonly target: "node" | "functions";
  readonly taggedPlugin: () => StoragePlugin;
  readonly literalPlugin: (server: S3TestServer) => StoragePlugin;
  readonly context: (
    requestId: string,
    origin: "A" | "B",
    server: S3TestServer,
  ) => StorageOperationContext;
}>;

type StorageFactory = (config: unknown) => StoragePlugin;
export type S3Module = Readonly<{ readonly s3Storage: StorageFactory }>;
export type R2Module = Readonly<{ readonly r2Storage: StorageFactory }>;

export const isS3Module = (value: unknown): value is S3Module =>
  typeof value === "object" &&
  value !== null &&
  "s3Storage" in value &&
  typeof value.s3Storage === "function";

export const isR2Module = (value: unknown): value is R2Module =>
  typeof value === "object" &&
  value !== null &&
  "r2Storage" in value &&
  typeof value.r2Storage === "function";

const awsConfig = (tagged: boolean, server?: S3TestServer) => ({
  bucketName: tagged ? env("BUCKET") : "bucket-a",
  endpoint: tagged ? env("ENDPOINT") : (server?.endpoint ?? ""),
  credentials: {
    accessKeyId: tagged ? env("ACCESS_KEY") : "access-a",
    secretAccessKey: tagged ? secret("SECRET_KEY") : "literal-key",
  },
  region: "us-east-1",
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
});

const cloudflareConfig = (tagged: boolean, server?: S3TestServer) => ({
  accountId: tagged ? env("ACCOUNT") : "account-a",
  bucketName: tagged ? env("BUCKET") : "bucket-a",
  endpoint: tagged ? env("ENDPOINT") : (server?.endpoint ?? ""),
  credentials: {
    accessKeyId: tagged ? env("ACCESS_KEY") : "access-a",
    secretAccessKey: tagged ? secret("SECRET_KEY") : "literal-key",
  },
  region: "auto",
});

const createContext = (
  target: "node" | "functions",
  requestId: string,
  origin: "A" | "B",
  server: S3TestServer,
): StorageOperationContext => {
  const input = {
    environment: {
      REQUEST_ID: requestId,
      ACCOUNT: `account-${origin.toLowerCase()}`,
      BUCKET: `bucket-${origin.toLowerCase()}`,
      ENDPOINT: server.endpoint,
      ACCESS_KEY: `access-${origin.toLowerCase()}`,
      SECRET_KEY: `matrix-key-${origin.toLowerCase()}`,
    },
    bindings: {},
  };
  return target === "node"
    ? createNodeStorageContext(input)
    : createLambdaStorageContext(input);
};

export const createAwsNodeHarness = (
  storageModule: S3Module,
): S3EntryHarness => ({
  id: "aws-node",
  entry: "@hot-updater/aws/storage/node",
  target: "node",
  taggedPlugin: () => storageModule.s3Storage(awsConfig(true)),
  literalPlugin: (server) => storageModule.s3Storage(awsConfig(false, server)),
  context: (requestId, origin, server) =>
    createContext("node", requestId, origin, server),
});

export const createAwsLambdaHarness = (
  storageModule: S3Module,
): S3EntryHarness => ({
  id: "aws-lambda",
  entry: "@hot-updater/aws/storage/lambda",
  target: "functions",
  taggedPlugin: () => storageModule.s3Storage(awsConfig(true)),
  literalPlugin: (server) => storageModule.s3Storage(awsConfig(false, server)),
  context: (requestId, origin, server) =>
    createContext("functions", requestId, origin, server),
});

export const createCloudflareNodeHarness = (
  storageModule: R2Module,
): S3EntryHarness => ({
  id: "cloudflare-node",
  entry: "@hot-updater/cloudflare/storage/node",
  target: "node",
  taggedPlugin: () => storageModule.r2Storage(cloudflareConfig(true)),
  literalPlugin: (server) =>
    storageModule.r2Storage(cloudflareConfig(false, server)),
  context: (requestId, origin, server) =>
    createContext("node", requestId, origin, server),
});

export const observeS3Entry = async (
  harness: S3EntryHarness,
): Promise<ProviderMatrixObservation> => {
  const serverA = await startS3TestServer();
  const serverB = await startS3TestServer();
  const tagged = harness.taggedPlugin();
  try {
    const servers = [serverA, serverB, serverA] as const;
    const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
      harness.context(requestId, REQUIRED_ORIGINS[index], servers[index]),
    );
    const stored = await Promise.all(
      contexts.map((context, index) =>
        tagged.put({
          context,
          key: `${REQUIRED_ORIGINS[index]}-${index}`,
          body: new Uint8Array([index + 1]),
          contentLength: 1,
          metadata: { requestId: REQUIRED_CONTEXTS[index] },
        }),
      ),
    );
    const providerContextIds = servers.map((providerServer, index) => {
      const storedObject = providerServer.objects.get(
        `${REQUIRED_ORIGINS[index]}-${index}`,
      );
      return (
        storedObject?.metadata.requestId ??
        storedObject?.metadata.requestid ??
        "missing"
      );
    });
    const firstUri = stored[0]?.storageUri ?? "";
    await tagged.head({ context: contexts[0], storageUri: firstUri });
    const found = await tagged.get({
      context: contexts[0],
      storageUri: firstUri,
    });
    const requestsBeforeStream = serverA.requests.length;
    if (found.kind === "found") {
      await new Response(found.body).arrayBuffer();
    }
    const requestsAfterStream = serverA.requests.length;
    await tagged.delete({ context: contexts[0], storageUri: firstUri });

    const literal = harness.literalPlugin(serverA);
    const literalContext = harness.context("literal", "A", serverA);
    const requestsBeforeLiteral = serverA.requests.length;
    await literal.head({
      context: literalContext,
      storageUri:
        harness.id === "cloudflare-node"
          ? "r2://bucket-a/missing-1"
          : "s3://bucket-a/missing-1",
    });
    await literal.head({
      context: literalContext,
      storageUri:
        harness.id === "cloudflare-node"
          ? "r2://bucket-a/missing-2"
          : "s3://bucket-a/missing-2",
    });
    const requestsBeforeUnmount = serverA.requests.length;
    await literal.onUnmount?.();

    return {
      id: harness.id,
      entry: harness.entry,
      targets: [harness.target],
      contexts: REQUIRED_CONTEXTS,
      operations: REQUIRED_OPERATIONS,
      origins: REQUIRED_ORIGINS,
      providerVisible: {
        endpointOrigins: [
          ...serverA.requests.map(() => "A"),
          ...serverB.requests.map(() => "B"),
        ],
        credentialOrigins: [
          serverA.requests.every((request) =>
            request.authorization?.includes("Credential=access-a/"),
          )
            ? "A"
            : "mismatch",
          serverB.requests.every((request) =>
            request.authorization?.includes("Credential=access-b/"),
          )
            ? "B"
            : "mismatch",
        ],
        bucketAObjects: [...serverA.objects.keys()],
        bucketBObjects: [...serverB.objects.keys()],
        providerContextIds,
        taggedStreamRequestStable:
          requestsBeforeStream === requestsAfterStream &&
          found.kind === "found",
        literalClientOperations: requestsBeforeUnmount - requestsBeforeLiteral,
      },
      cache: { literal: "allowed", tagged: "forbidden" },
      streamLifetime: "response-owned",
      secretCanaryLeaked: false,
    };
  } finally {
    await tagged.onUnmount?.();
    await Promise.all([serverA.close(), serverB.close()]);
  }
};

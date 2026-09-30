import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
} from "@hot-updater/test-utils/node";
import { afterAll, beforeAll } from "vitest";

import { s3Storage } from "./s3Storage";

const LOCALSTACK_IMAGE = "localstack/localstack:3";
const REGION = "us-east-1";
const BUCKET = "hot-updater-conformance";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

assertDockerDaemonAvailable(
  "s3Storage conformance on LocalStack requires a running Docker daemon.",
);

let endpoint = "";
let localstack: ReturnType<typeof spawnRuntime> | undefined;

const createClient = () =>
  new S3Client({ credentials, endpoint, forcePathStyle: true, region: REGION });

const waitForLocalstack = async (runtime: ReturnType<typeof spawnRuntime>) => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (runtime.child.exitCode !== null) {
      throw new Error(
        `LocalStack exited early: ${formatRuntimeLogs(runtime.logs)}`,
      );
    }
    try {
      await createClient().send(new ListBucketsCommand({}));
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

/** Deletes every object below `basePath` from the bucket. */
const deleteBelow = async (basePath: string) => {
  const client = createClient();
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
        Prefix: `${basePath}/`,
      }),
    );
    const keys = (listed.Contents ?? []).flatMap(({ Key }) =>
      Key === undefined ? [] : [{ Key }],
    );
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    continuationToken = listed.NextContinuationToken;
  } while (continuationToken !== undefined);
};

beforeAll(async () => {
  const port = await findOpenPort();
  endpoint = `http://127.0.0.1:${port}`;
  localstack = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "--name",
      `hot-updater-s3-conformance-${process.pid}`,
      "-p",
      `127.0.0.1:${port}:4566`,
      "-e",
      "SERVICES=s3",
      "-e",
      `DEFAULT_REGION=${REGION}`,
      LOCALSTACK_IMAGE,
    ],
    cwd: process.cwd(),
  });
  await waitForLocalstack(localstack);
  await createClient().send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 120_000);

afterAll(async () => {
  if (localstack) await stopRuntime(localstack.child);
});

/** s3Storage on LocalStack's S3, each case below a base path of its own. */
setupStorageAdapterTestSuite({
  name: "s3Storage (LocalStack)",
  createStorage: async () => {
    const basePath = `conformance/${crypto.randomUUID()}`;
    return {
      storage: s3Storage({
        basePath,
        bucketName: BUCKET,
        credentials,
        downloadUrlSigningKey: "test-signing-key",
        endpoint,
        forcePathStyle: true,
        region: REGION,
      }),
      basePath,
      cleanup: () => deleteBelow(basePath),
    };
  },
  operations: [
    "put",
    "get",
    "getDownloadUrl",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
});

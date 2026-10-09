import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { s3Storage } from "./s3Storage";

/** An S3 bucket in memory: exact keys, string prefixes, and short pages. */
const { objects } = vi.hoisted(() => ({
  objects: new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; contentType?: string; modifiedAt: Date }
  >(),
}));

const BUCKET = "updates";
const LIST_PAGE_SIZE = 3;

const s3Error = (name: string) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(
      private readonly options: {
        params: {
          Body: ReadableStream<Uint8Array>;
          Bucket: string;
          ContentType?: string;
          Key: string;
        };
      },
    ) {}

    async done() {
      const { Body, Bucket, ContentType, Key } = this.options.params;
      const body = new Uint8Array(await new Response(Body).arrayBuffer());
      objects.set(Key, {
        body,
        contentType: ContentType,
        modifiedAt: new Date(),
      });
      return { Bucket, Key };
    }
  },
}));

vi.spyOn(S3Client.prototype, "send").mockImplementation(
  async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (object === undefined) throw s3Error("NoSuchKey");
      return {
        Body: { transformToWebStream: () => new Response(object.body).body },
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
      } as never;
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (object === undefined) throw s3Error("NotFound");
      return { ContentLength: object.body.byteLength } as never;
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key!);
      return {} as never;
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of command.input.Delete?.Objects ?? []) {
        objects.delete(Key!);
      }
      return {} as never;
    }
    if (command instanceof ListObjectsV2Command) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(command.input.Prefix ?? ""))
        .sort();
      const start = Number(command.input.ContinuationToken ?? 0);
      const end = start + LIST_PAGE_SIZE;
      return {
        Contents: keys.slice(start, end).map((Key) => ({
          Key,
          LastModified: objects.get(Key)!.modifiedAt,
          Size: objects.get(Key)!.body.byteLength,
        })),
        NextContinuationToken: end < keys.length ? String(end) : undefined,
      } as never;
    }
    throw new Error("Unexpected S3 command.");
  },
);

setupStorageAdapterTestSuite({
  name: "s3Storage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: s3Storage({
        basePath: "ota",
        bucketName: BUCKET,
        // What presigning signs with; no request leaves the mocked client.
        credentials: {
          accessKeyId: "access-key-id",
          secretAccessKey: "secret-access-key",
        },
        region: "us-east-1",
      }),
      basePath: "ota",
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

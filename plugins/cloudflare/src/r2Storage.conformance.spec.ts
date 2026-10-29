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

import { r2Storage } from "./r2Storage";

/** An R2 bucket behind its S3 API, in memory: exact keys, string prefixes, and short pages. */
const { objects } = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array<ArrayBuffer>>(),
}));

const LIST_PAGE_SIZE = 3;

const notFound = (name: string) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(
      private readonly options: {
        params: { Body: ReadableStream<Uint8Array>; Key: string };
      },
    ) {}

    async done() {
      const { Body, Key } = this.options.params;
      objects.set(Key, new Uint8Array(await new Response(Body).arrayBuffer()));
      return {};
    }
  },
}));

vi.spyOn(S3Client.prototype, "send").mockImplementation(
  async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (body === undefined) throw notFound("NoSuchKey");
      return {
        Body: { transformToWebStream: () => new Response(body).body },
        ContentLength: body.byteLength,
      } as never;
    }
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key!)) throw notFound("NotFound");
      return {} as never;
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
          Size: objects.get(Key)!.byteLength,
        })),
        NextContinuationToken: end < keys.length ? String(end) : undefined,
      } as never;
    }
    throw new Error("Unexpected S3 command.");
  },
);

setupStorageAdapterTestSuite({
  name: "r2Storage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: r2Storage({
        accountId: "account-id",
        basePath: "ota",
        bucketName: "updates",
        credentials: {
          accessKeyId: "access-key-id",
          secretAccessKey: "secret-access-key",
        },
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

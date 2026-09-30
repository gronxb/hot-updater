import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { r2Storage } from "./r2Storage";

/** An R2 bucket behind its S3 API, in memory. */
const { objects } = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array<ArrayBuffer>>(),
}));

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
        downloadUrlSigningKey: "test-signing-key",
      }),
      basePath: "ota",
    };
  },
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});

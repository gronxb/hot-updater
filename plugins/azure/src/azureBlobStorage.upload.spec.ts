import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { RestError } from "@azure/storage-blob";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { azureBlobStorage } from "./azureBlobStorage";

/**
 * Uploads through @azure/storage-blob against a fake Blob endpoint, so a
 * failed request takes the path the SDK's retry policy takes for it.
 */
const bodies: Buffer[] = [];
/** Statuses to answer the next requests with, before answering 201. */
let failures: number[] = [];
let server: Server;
let blobEndpoint: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks));
    const status = failures.shift() ?? 201;
    response.writeHead(status, {
      "x-ms-request-id": "request",
      ...(status === 201 ? { etag: '"etag"' } : {}),
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  blobEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/account`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  bodies.length = 0;
  failures = [];
});

/** `byteLength` bytes in chunks of 64 KiB, as a file stream gives them. */
const patternStream = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength).map((_, index) => index % 251);
  let offset = 0;
  return {
    bytes: Buffer.from(bytes),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
        offset += 64 * 1024;
      },
    }),
  };
};

const put = (byteLength: number) => {
  const { bytes, body } = patternStream(byteLength);
  return {
    bytes,
    result: azureBlobStorage({
      connectionString: `DefaultEndpointsProtocol=http;AccountName=account;AccountKey=${Buffer.from("key").toString("base64")};BlobEndpoint=${blobEndpoint};`,
      containerName: "bundles",
    }).put({
      key: "bundles/bundle.zip",
      body,
      contentLength: byteLength,
      contentType: "application/zip",
    }),
  };
};

describe("azureBlobStorage put", () => {
  it("sends a body of up to 16 MiB again after Blob answers 503", async () => {
    failures = [503];
    const { bytes, result } = put(1024 * 1024);

    await expect(result).resolves.toEqual({
      storageUri: "azblob://bundles/bundles/bundle.zip",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.equals(bytes)).toBe(true);
    expect(bodies[1]?.equals(bytes)).toBe(true);
  }, 15_000);

  it("fails a streamed body over 16 MiB on its one try instead of sending it again", async () => {
    failures = [503];
    const { result } = put(17 * 1024 * 1024);

    const error = await result.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).statusCode).toBe(503);
    expect(bodies).toHaveLength(1);

    bodies.length = 0;
    const next = put(17 * 1024 * 1024);
    await expect(next.result).resolves.toEqual({
      storageUri: "azblob://bundles/bundles/bundle.zip",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.equals(next.bytes)).toBe(true);
  }, 15_000);
});

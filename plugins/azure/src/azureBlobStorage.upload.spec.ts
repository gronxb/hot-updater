import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { azureBlobStorage } from "./azureBlobStorage";

/**
 * Uploads through @azure/storage-blob against a fake Blob endpoint that
 * fails every upload, so a failed request takes the path the SDK's retry
 * policy takes for it.
 */
const bodies: Buffer[] = [];
/** The status that fails an upload. */
let status: number;
let server: Server;
let blobEndpoint: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks));
    if (status === 503) {
      response.writeHead(503, { "x-ms-request-id": "request" });
      response.end();
      return;
    }
    response.writeHead(status, {
      "content-type": "application/xml",
      "x-ms-error-code": "AuthorizationFailure",
    });
    response.end(
      '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationFailure</Code><Message>This request is not authorized.\nRequestId:request</Message></Error>',
    );
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
});

const bytes = Buffer.alloc(1024 * 1024, 7);
const put = () =>
  azureBlobStorage({
    connectionString: `DefaultEndpointsProtocol=http;AccountName=account;AccountKey=${Buffer.from("key").toString("base64")};BlobEndpoint=${blobEndpoint};`,
    containerName: "bundles",
  }).put({
    key: "bundles/bundle.zip",
    body: new Blob([bytes]).stream(),
    contentLength: bytes.byteLength,
    contentType: "application/zip",
  });

describe("azureBlobStorage put", () => {
  it("fails an upload once with the HTTP status instead of hanging", async () => {
    status = 503;

    await expect(put()).rejects.toThrow(
      /^Azure Blob Storage answered HTTP 503 while uploading bundles\/bundle\.zip$/,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.equals(bytes)).toBe(true);
  }, 5_000);

  it("adds Azure's error code for a refused upload", async () => {
    status = 403;

    await expect(put()).rejects.toThrow(
      /^Azure Blob Storage answered HTTP 403 while uploading bundles\/bundle\.zip: AuthorizationFailure$/,
    );
    expect(bodies).toHaveLength(1);
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { vercelBlobStorage } from "./vercelBlobStorage";

/**
 * Uploads through @vercel/blob against a fake Blob API, so a failed request
 * takes the path @vercel/blob takes for it: it retries a 5xx with the same
 * request body.
 */
type Received = { action: string; part?: string; bytes: Buffer };
const received: Received[] = [];
/**
 * The status that fails a request, when it is the `attempt`th of its
 * action and part, or undefined to answer it.
 */
let failure: (request: Received, attempt: number) => number | undefined;
let server: Server;
let previousApiUrl: string | undefined;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const action = String(request.headers["x-mpu-action"] ?? "put");
    const part = request.headers["x-mpu-part-number"];
    const current: Received = {
      action,
      ...(typeof part === "string" ? { part } : {}),
      bytes: Buffer.concat(chunks),
    };
    received.push(current);
    const status = failure(
      current,
      received.filter(
        (other) => other.action === action && other.part === current.part,
      ).length,
    );
    if (status !== undefined) {
      response.writeHead(status, { "content-type": "text/html" });
      response.end(`<html><body>${status}</body></html>`);
      return;
    }
    const pathname = new URL(request.url ?? "", "http://blob").searchParams.get(
      "pathname",
    );
    const answer =
      action === "create"
        ? { key: "key", uploadId: "upload" }
        : action === "upload"
          ? { etag: `etag-${part}` }
          : {
              url: `https://abc123.private.blob.vercel-storage.com/${pathname}`,
              downloadUrl: `https://abc123.private.blob.vercel-storage.com/${pathname}?download=1`,
              pathname,
              contentType: "application/zip",
              contentDisposition: "inline",
              etag: "etag",
            };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  previousApiUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (previousApiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL;
  else process.env.VERCEL_BLOB_API_URL = previousApiUrl;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  failure = () => undefined;
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

const put = (body: ReadableStream<Uint8Array>, contentLength?: number) =>
  vercelBlobStorage({ token: "vercel_blob_rw_AbC123_secret" }).put({
    key: "bundles/bundle.zip",
    body,
    contentType: "application/zip",
    ...(contentLength === undefined ? {} : { contentLength }),
  });

const storageUri = "vercel-blob://store_AbC123/bundles/bundle.zip";

describe("vercelBlobStorage put", () => {
  it("sends a body of up to 16 MiB again after Blob answers 503", async () => {
    failure = (_request, attempt) => (attempt === 1 ? 503 : undefined);
    const { bytes, body } = patternStream(1024 * 1024);

    await expect(put(body, bytes.byteLength)).resolves.toEqual({ storageUri });
    expect(received.map(({ action }) => action)).toEqual(["put", "put"]);
    expect(received[0]?.bytes.equals(bytes)).toBe(true);
    expect(received[1]?.bytes.equals(bytes)).toBe(true);
  }, 15_000);

  it("sends a body of unknown length that ends within 16 MiB in one request", async () => {
    const { bytes, body } = patternStream(1024 * 1024);

    await expect(put(body)).resolves.toEqual({ storageUri });
    expect(received.map(({ action }) => action)).toEqual(["put"]);
    expect(received[0]?.bytes.equals(bytes)).toBe(true);
  });

  it("uploads a larger body in parts and sends a part again after Blob answers 503", async () => {
    failure = ({ part }, attempt) =>
      part === "1" && attempt === 1 ? 503 : undefined;
    const { bytes, body } = patternStream(17 * 1024 * 1024);

    await expect(put(body, bytes.byteLength)).resolves.toEqual({ storageUri });
    const parts = received.filter(({ action }) => action === "upload");
    const firstPart = bytes.subarray(0, 8 * 1024 * 1024);
    expect(parts.filter(({ part }) => part === "1")).toHaveLength(2);
    for (const { bytes: sent } of parts.filter(({ part }) => part === "1")) {
      expect(sent.equals(firstPart)).toBe(true);
    }
    expect(
      Buffer.concat(
        ["1", "2", "3"].map(
          (number) =>
            parts.findLast(({ part }) => part === number)?.bytes ??
            Buffer.alloc(0),
        ),
      ).equals(bytes),
    ).toBe(true);
    expect(received.at(0)?.action).toBe("create");
    expect(received.at(-1)?.action).toBe("complete");
  }, 30_000);
});

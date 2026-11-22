import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { vercelBlobStorage } from "./vercelBlobStorage";

/**
 * Uploads through @vercel/blob against a fake Blob API that answers 503
 * with an HTML page, so a failed request takes the path @vercel/blob takes
 * for it: it retries a 5xx with the same request body.
 */
const bodies: Buffer[] = [];
let server: Server;
let previousApiUrl: string | undefined;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks));
    response.writeHead(503, { "content-type": "text/html" });
    response.end("<html><body>503 Service Unavailable</body></html>");
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
  bodies.length = 0;
});

describe("vercelBlobStorage put", () => {
  it("fails once with a one-line error instead of the resend TypeError", async () => {
    const bytes = Buffer.alloc(1024 * 1024, 7);

    const error = await vercelBlobStorage({
      token: "vercel_blob_rw_AbC123_secret",
    })
      .put({
        key: "bundles/bundle.zip",
        body: new Blob([bytes]).stream(),
        contentLength: bytes.byteLength,
        contentType: "application/zip",
      })
      .catch((reason: unknown) => reason);

    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(
      /^Vercel Blob failed while uploading bundles\/bundle\.zip: /,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.equals(bytes)).toBe(true);
  }, 10_000);
});

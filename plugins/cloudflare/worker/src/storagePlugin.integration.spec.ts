import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { r2Storage } from "../../src/worker";

const UNKNOWN_LENGTH_KEY = "storage-tests/unknown-length.txt";
const KNOWN_LENGTH_KEY = "storage-tests/known-length.txt";

const createChunkedBody = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

const createStorage = () =>
  r2Storage({
    bucket: env.BUCKET,
    bucketName: env.BUCKET_NAME,
    downloadUrlSigningKey: env.STORAGE_DOWNLOAD_URL_SIGNING_KEY,
  });

afterEach(async () => {
  await env.BUCKET.delete([UNKNOWN_LENGTH_KEY, KNOWN_LENGTH_KEY]);
});

describe("Cloudflare Worker R2 storage uploads", () => {
  it("writes exact bytes from an unknown-length stream", async () => {
    const storage = createStorage();

    await storage.put({
      key: UNKNOWN_LENGTH_KEY,
      body: createChunkedBody("unknown", "-length"),
      contentType: "text/plain",
    });

    await expect(
      env.BUCKET.get(UNKNOWN_LENGTH_KEY).then((item) => item?.text()),
    ).resolves.toBe("unknown-length");
  });

  it("streams known-length bytes through FixedLengthStream", async () => {
    const storage = createStorage();

    await storage.put({
      key: KNOWN_LENGTH_KEY,
      body: createChunkedBody("known", "-length"),
      contentLength: 12,
      contentType: "text/plain",
    });

    await expect(
      env.BUCKET.get(KNOWN_LENGTH_KEY).then((item) => item?.text()),
    ).resolves.toBe("known-length");
  });
});

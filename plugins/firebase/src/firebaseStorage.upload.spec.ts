import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { firebaseStorage } from "./firebaseStorage";

/**
 * Uploads through @google-cloud/storage against a fake Cloud Storage JSON
 * API, so a failed upload takes the path the SDK takes for it. The fake
 * takes a single-request (multipart) upload and a resumable one.
 */
type Upload = { uploadType: string; bytes: Buffer };
/** Every request that carried an upload's bytes. */
const uploads: Upload[] = [];
/**
 * The status that fails the `attempt`th upload, "drop" to close its
 * connection unanswered, or undefined to store it.
 */
let failure: (attempt: number) => number | "drop" | undefined;
let server: Server;
let previousEmulatorHost: string | undefined;

const CRC32C_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return crc >>> 0;
});
/** The base64 big-endian CRC32C Cloud Storage reports for `bytes`. */
const crc32c = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  const digest = Buffer.alloc(4);
  digest.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return digest.toString("base64");
};

/** The media part of a multipart/related upload body. */
const mediaOf = (body: Buffer, contentType: string) => {
  const boundary = `--${/boundary=([^;]+)/.exec(contentType)?.[1]}`;
  const parts: Buffer[] = [];
  let start = body.indexOf(boundary) + boundary.length;
  for (;;) {
    const end = body.indexOf(`\r\n${boundary}`, start);
    if (end === -1) break;
    parts.push(body.subarray(body.indexOf("\r\n\r\n", start) + 4, end));
    start = end + 2 + boundary.length;
  }
  return parts[1] ?? Buffer.alloc(0);
};

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://storage");
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) chunks.push(chunk as Buffer);
    } catch {
      // The connection closed before the request ended.
      return;
    }
    const body = Buffer.concat(chunks);
    const uploadType = url.searchParams.get("uploadType");
    if (request.method === "POST" && uploadType === "resumable") {
      response.writeHead(200, {
        location: `http://${request.headers.host}/upload/session`,
      });
      response.end();
      return;
    }
    const bytes =
      uploadType === "multipart"
        ? mediaOf(body, String(request.headers["content-type"]))
        : body;
    uploads.push({ uploadType: uploadType ?? "resumable", bytes });
    const status = failure(uploads.length);
    if (status === "drop") {
      request.socket.destroy();
      return;
    }
    if (status !== undefined) {
      const json = status < 500;
      response.writeHead(status, {
        "content-type": json ? "application/json" : "text/html",
      });
      response.end(
        json
          ? JSON.stringify({ error: { code: status, message: "Forbidden" } })
          : `<!DOCTYPE html><html><body>${status} Service Unavailable</body></html>`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        bucket: "updates",
        name: "bundles/bundle.zip",
        generation: "1",
        size: String(bytes.byteLength),
        crc32c: crc32c(bytes),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  previousEmulatorHost = process.env.STORAGE_EMULATOR_HOST;
  // The client sends no credentials to an emulator.
  process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (previousEmulatorHost === undefined) {
    delete process.env.STORAGE_EMULATOR_HOST;
  } else {
    process.env.STORAGE_EMULATOR_HOST = previousEmulatorHost;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  uploads.length = 0;
  failure = () => undefined;
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const storage = firebaseStorage({
  credential: cert({
    clientEmail: "uploads@project.iam.gserviceaccount.com",
    privateKey,
    projectId: "project",
  }),
  projectId: "project",
  storageBucket: "updates",
});

/** `byteLength` bytes in chunks of 64 KiB, as a file stream gives them. */
const patternStream = (byteLength: number, failAt?: number) => {
  const bytes = new Uint8Array(byteLength).map((_, index) => index % 251);
  let offset = 0;
  return {
    bytes: Buffer.from(bytes),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (failAt !== undefined && offset >= failAt) {
          controller.error(new Error("The bundle could not be read"));
          return;
        }
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

const put = (byteLength: number, failAt?: number) => {
  const { bytes, body } = patternStream(byteLength, failAt);
  return {
    bytes,
    result: storage.put({
      key: "bundles/bundle.zip",
      body,
      contentLength: byteLength,
      contentType: "application/zip",
    }),
  };
};

const storageUri = "gs://updates/bundles/bundle.zip";

describe("firebaseStorage put", () => {
  it("sends a body of up to 16 MiB again after Storage answers 503 with an HTML page", async () => {
    failure = (attempt) => (attempt === 1 ? 503 : undefined);
    const { bytes, result } = put(1024 * 1024);

    await expect(result).resolves.toEqual({ storageUri });
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.bytes.equals(bytes)).toBe(true);
    }
  }, 15_000);

  it("names the HTTP status in one line after its last try, and keeps the client's retries", async () => {
    failure = () => 503;

    await expect(put(1024).result).rejects.toThrow(
      /^Firebase Storage answered HTTP 503 while uploading bundles\/bundle\.zip$/,
    );
    expect(uploads).toHaveLength(3);
    // The SDK turns its own retries off for an upload without a precondition.
    expect(getStorage().bucket("updates").storage.retryOptions.autoRetry).toBe(
      true,
    );
  }, 15_000);

  it("sends the upload again after its connection drops unanswered", async () => {
    failure = (attempt) => (attempt === 1 ? "drop" : undefined);
    const { bytes, result } = put(1024 * 1024);

    await expect(result).resolves.toEqual({ storageUri });
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.bytes.equals(bytes)).toBe(true);
    }

    failure = () => "drop";
    uploads.length = 0;
    await expect(put(1024).result).rejects.toThrow(
      /^Firebase Storage did not answer while uploading bundles\/bundle\.zip: .*socket hang up$/,
    );
    expect(uploads).toHaveLength(3);
  }, 15_000);

  it("does not send an upload Storage refused again", async () => {
    failure = () => 403;

    await expect(put(1024).result).rejects.toThrow(
      /^Firebase Storage answered HTTP 403 while uploading bundles\/bundle\.zip: Forbidden$/,
    );
    expect(uploads).toHaveLength(1);
  });

  it("streams a body over 16 MiB once and names the status it failed with", async () => {
    failure = () => 503;
    const { bytes, result } = put(17 * 1024 * 1024);

    await expect(result).rejects.toThrow(
      /^Firebase Storage answered HTTP 503 while uploading bundles\/bundle\.zip$/,
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bytes.equals(bytes)).toBe(true);

    failure = () => undefined;
    uploads.length = 0;
    const next = put(17 * 1024 * 1024);
    await expect(next.result).resolves.toEqual({ storageUri });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bytes.equals(next.bytes)).toBe(true);
  }, 15_000);

  it("rejects a streamed body that fails and stores nothing", async () => {
    await expect(
      put(17 * 1024 * 1024, 16 * 1024 * 1024 + 128 * 1024).result,
    ).rejects.toThrow("The bundle could not be read");
    // The request never ends its body, so Storage keeps no object.
    expect(uploads).toEqual([]);
  }, 15_000);
});

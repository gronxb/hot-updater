import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { firebaseStorage } from "./firebaseStorage";

/**
 * Uploads through @google-cloud/storage against a fake Cloud Storage JSON
 * API, so a failed upload takes the path the SDK takes for it.
 */
/** Every request that carried an upload's bytes. */
const uploads: Buffer[] = [];
/** The status that fails an upload. */
let status: number;
let server: Server;
let previousEmulatorHost: string | undefined;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) chunks.push(chunk as Buffer);
    } catch {
      // The connection closed before the request ended.
      return;
    }
    if (
      new URL(request.url ?? "", "http://storage").searchParams.get(
        "uploadType",
      ) === "resumable"
    ) {
      // A resumable session, so a failure lands on the request with bytes.
      response.writeHead(200, {
        location: `http://${request.headers.host}/upload/session`,
      });
      response.end();
      return;
    }
    uploads.push(Buffer.concat(chunks));
    // Google's front end answers a timeout and a 5xx with an HTML page.
    const json = status < 500 && status !== 408;
    response.writeHead(status, {
      "content-type": json ? "application/json" : "text/html",
    });
    response.end(
      json
        ? JSON.stringify({ error: { code: status, message: "Forbidden" } })
        : `<!DOCTYPE html><html><body>${status} That’s an error.</body></html>`,
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
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAt !== undefined && offset >= failAt) {
        controller.error(new Error("The bundle could not be read"));
        return;
      }
      if (offset >= byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(64 * 1024).fill(offset % 251));
      offset += 64 * 1024;
    },
  });
};

const put = (byteLength: number, failAt?: number) =>
  storage.put({
    key: "bundles/bundle.zip",
    body: patternStream(byteLength, failAt),
    contentLength: byteLength,
    contentType: "application/zip",
  });

describe("firebaseStorage put", () => {
  it("fails once with the HTTP status when Storage answers 503 with an HTML page", async () => {
    status = 503;

    await expect(put(1024 * 1024)).rejects.toThrow(
      /^Firebase Storage answered HTTP 503 while uploading bundles\/bundle\.zip$/,
    );
    expect(uploads).toHaveLength(1);
    // The SDK turns its own retries off for an upload without a precondition,
    // on the client firebase-admin shares.
    expect(getStorage().bucket("updates").storage.retryOptions.autoRetry).toBe(
      true,
    );
  });

  it("keeps Storage's message for a refused upload", async () => {
    status = 403;

    await expect(put(1024)).rejects.toThrow(
      /^Firebase Storage answered HTTP 403 while uploading bundles\/bundle\.zip: Forbidden$/,
    );
    expect(uploads).toHaveLength(1);
  });

  it("leaves out the HTML page Storage answers a timed-out upload with", async () => {
    status = 408;

    await expect(put(1024)).rejects.toThrow(
      /^Firebase Storage answered HTTP 408 while uploading bundles\/bundle\.zip$/,
    );
    expect(uploads).toHaveLength(1);
  });

  it("rejects a body that fails and stores nothing", async () => {
    status = 503;

    await expect(put(1024 * 1024, 512 * 1024)).rejects.toThrow(
      "The bundle could not be read",
    );
    // The request never ends its body, so Storage keeps no object.
    expect(uploads).toEqual([]);
  });
});

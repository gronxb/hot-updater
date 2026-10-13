import http from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";

import {
  createArchiveInterruption,
  interruptArchive,
  resumeArchive,
} from "./archive-interruption.ts";

const archiveBytes = () =>
  Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 251);

function get(port: number, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{
    aborted: boolean;
    body: Buffer;
    headers: http.IncomingHttpHeaders;
    status: number;
  }>((resolve, reject) => {
    const request = http.get(
      { headers, host: "127.0.0.1", path: "/bundle.tar.br", port },
      (response) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("aborted", () => {
          aborted = true;
        });
        response.on("error", () => {
          aborted = true;
        });
        response.on("close", () => {
          resolve({
            aborted: aborted || !response.complete,
            body: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
  });
}

describe("archive interruption", () => {
  it("promises the whole archive, sends half, and loses the connection", async () => {
    const entry = createArchiveInterruption(archiveBytes());
    const server = serve({
      fetch: () => interruptArchive(entry).response,
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;

      const response = await get(port);

      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({
        "accept-ranges": "bytes",
        "content-length": String(64 * 1024),
        etag: entry.etag,
      });
      expect(response.headers["last-modified"]).toBeTruthy();
      expect(response.aborted).toBe(true);
      expect(response.body).toEqual(Buffer.from(entry.body.subarray(0, 32768)));
      expect(entry.interruptions).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("answers the resumed request with the rest as a 206", async () => {
    const entry = createArchiveInterruption(archiveBytes());

    const resumed = resumeArchive(
      entry,
      new Request("http://localhost/bundle.tar.br", {
        headers: { "if-range": entry.etag, range: "bytes=32768-" },
      }),
    );

    expect(resumed?.response.status).toBe(206);
    expect(resumed?.sentBytes).toBe(32768);
    expect(
      Object.fromEntries(resumed?.response.headers.entries() ?? []),
    ).toMatchObject({
      "content-length": "32768",
      "content-range": "bytes 32768-65535/65536",
      etag: entry.etag,
    });
    expect(new Uint8Array(await resumed!.response.arrayBuffer())).toEqual(
      entry.body.subarray(32768),
    );
    expect(entry.resumes).toBe(1);
  });

  it("leaves other requests to the proxy", () => {
    const entry = createArchiveInterruption(archiveBytes());
    const request = (headers: Record<string, string>) =>
      new Request("http://localhost/bundle.tar.br", { headers });

    expect(resumeArchive(entry, request({}))).toBeNull();
    expect(
      resumeArchive(
        entry,
        request({ "if-range": '"another"', range: "bytes=10-" }),
      ),
    ).toBeNull();
    expect(resumeArchive(entry, request({ range: "bytes=0-9" }))).toBeNull();
    expect(
      resumeArchive(entry, request({ range: "bytes=65536-" }))?.response.status,
    ).toBe(416);
    expect(entry.resumes).toBe(0);
  });
});

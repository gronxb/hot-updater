import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
import { createApi, testEventPayload } from "./handler.testFixtures";
import { toNodeHandler } from "./node";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

describe("server node entry", () => {
  it("converts a Web Request handler to Node middleware", async () => {
    const hotUpdater = {
      handler: async (request: Request) =>
        Response.json({
          method: request.method,
          pathname: new URL(request.url).pathname,
        }),
    };
    const middleware = toNodeHandler(hotUpdater);
    const headers = new Map<string, string | string[]>();
    const response = {
      body: "",
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string | string[]) {
        headers.set(name, value);
      },
      send(body: string) {
        this.body = body;
      },
      end() {},
    };

    await middleware(
      {
        method: "GET",
        url: "/api/check",
        headers: { host: "example.com" },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({
      method: "GET",
      pathname: "/api/check",
    });
  });

  it("preserves raw Express request bytes for event payload limits", async () => {
    // Given
    const api = createApi();
    const app = express();
    app.use("/hot-updater", express.raw({ type: "application/json" }));
    app.all(
      "/hot-updater/*",
      toNodeHandler({
        handler: createHandler(api, { basePath: "/hot-updater" }),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    const baseUrl = await listen(server);
    const oversizedBody = new TextEncoder().encode(
      `${JSON.stringify(testEventPayload)}${" ".repeat(17 * 1024)}`,
    );
    const oversizedInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedBody);
          controller.close();
        },
      }),
      duplex: "half",
    };

    try {
      // When
      const oversizedResponse = await fetch(
        `${baseUrl}/hot-updater/events`,
        oversizedInit,
      );
      const validResponse = await fetch(`${baseUrl}/hot-updater/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testEventPayload),
      });

      // Then
      expect(oversizedResponse.status).toBe(413);
      expect(validResponse.status).toBe(204);
      expect(api.appendBundleEvent).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it("fails closed when parsed event JSON cannot prove a valid raw size", async () => {
    // Given
    const api = createApi();
    const app = express();
    app.use(express.json());
    app.all(
      "/hot-updater/*",
      toNodeHandler({
        handler: createHandler(api, { basePath: "/hot-updater" }),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    const baseUrl = await listen(server);
    const parsedBody = new TextEncoder().encode(
      `${JSON.stringify(testEventPayload)}${" ".repeat(17 * 1024)}`,
    );
    const chunkedInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(parsedBody);
          controller.close();
        },
      }),
      duplex: "half",
    };

    try {
      // When
      const oversizedResponse = await fetch(`${baseUrl}/hot-updater/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: parsedBody,
      });
      const chunkedResponse = await fetch(
        `${baseUrl}/hot-updater/events`,
        chunkedInit,
      );

      // Then
      expect(oversizedResponse.status).toBe(413);
      expect(chunkedResponse.status).toBe(413);
      expect(api.appendBundleEvent).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("accepts parsed event JSON when Content-Length proves the raw size", async () => {
    // Given
    const api = createApi();
    const app = express();
    app.use(express.json());
    app.all(
      "/hot-updater/*",
      toNodeHandler({
        handler: createHandler(api, { basePath: "/hot-updater" }),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    const baseUrl = await listen(server);
    const body = JSON.stringify(testEventPayload);
    const contentLength = new TextEncoder().encode(body).byteLength;

    try {
      // When
      const response = await fetch(`${baseUrl}/hot-updater/events`, {
        method: "POST",
        headers: {
          "content-length": String(contentLength),
          "content-type": "application/json",
        },
        body,
      });

      // Then
      expect(response.status).toBe(204);
      expect(api.appendBundleEvent).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });
});

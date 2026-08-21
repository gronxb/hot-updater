import { describe, expect, it } from "vitest";

import { toNodeHandler } from "./node";

describe("server node entry", () => {
  it("converts a Web Request handler to Node middleware", async () => {
    const middleware = toNodeHandler(async (request: Request) =>
      Response.json({
        method: request.method,
        pathname: new URL(request.url).pathname,
      }),
    );
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
      send(body: Uint8Array) {
        this.body = new TextDecoder().decode(body);
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

  it("uses the mount-relative URL supplied by Express", async () => {
    const middleware = toNodeHandler(async (request: Request) =>
      Response.json({ pathname: new URL(request.url).pathname }),
    );
    const response = {
      body: "",
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: Uint8Array) {
        this.body = new TextDecoder().decode(body);
      },
      end() {},
    };

    await middleware(
      {
        method: "GET",
        url: "/channels",
        headers: { host: "example.com" },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
      },
      response,
    );

    expect(JSON.parse(response.body)).toEqual({
      pathname: "/channels",
    });
  });

  it("preserves binary response bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00]);
    const middleware = toNodeHandler(
      async () =>
        new Response(bytes, {
          headers: { "content-type": "application/zip" },
        }),
    );
    const response = {
      body: new Uint8Array(),
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: Uint8Array) {
        this.body = new Uint8Array(body);
      },
      end() {},
    };

    await middleware(
      {
        method: "GET",
        url: "/hot-updater/storage/token/signature",
        headers: { host: "example.com" },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect([...response.body]).toEqual([...bytes]);
  });
});

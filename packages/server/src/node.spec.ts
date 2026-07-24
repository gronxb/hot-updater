import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { toNodeHandler } from "./node";

describe("server node entry", () => {
  it("adapts an unread Node body as a lazy Web stream", async () => {
    // Given
    const read = vi.fn(function (this: Readable) {
      this.push(new Uint8Array([1, 2, 3]));
      this.push(null);
    });
    const request = Object.assign(new Readable({ read }), {
      get: (name: string) => (name === "host" ? "example.com" : undefined),
      headers: { host: "example.com" },
      method: "POST",
      protocol: "https",
      url: "/api/body",
    });
    let observedBody: ReadableStream<Uint8Array> | null = null;
    let observedBodyUsed = true;
    const middleware = toNodeHandler({
      handler: async (webRequest) => {
        observedBody = webRequest.body;
        observedBodyUsed = webRequest.bodyUsed;
        return new Response(null, { status: 204 });
      },
    });
    const response = {
      end() {},
      send() {},
      setHeader() {},
      status() {
        return this;
      },
    };

    // When
    await middleware(request, response);

    // Then
    expect(observedBody).not.toBeNull();
    expect(observedBodyUsed).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

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
});

import { describe, expect, it, vi } from "vitest";

import { toNodeHandler } from "./node";

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

  it("does not access a parsed body when the handler rejects the request", async () => {
    let bodyAccesses = 0;
    const request = {
      method: "POST",
      url: "/protected",
      headers: { host: "example.com" },
      protocol: "https",
      get: (name: string) => (name === "host" ? "example.com" : undefined),
    };
    Object.defineProperty(request, "body", {
      get() {
        bodyAccesses += 1;
        return { secret: "must-not-be-read" };
      },
    });
    const middleware = toNodeHandler({
      handler: async () =>
        Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = {
      body: "",
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: string) {
        this.body = body;
      },
      end() {},
    };

    await middleware(request, response);

    expect(response.statusCode).toBe(401);
    expect(bodyAccesses).toBe(0);
  });

  it("serializes a parsed body only after the handler reads it", async () => {
    const order: string[] = [];
    const middleware = toNodeHandler({
      handler: async (request) => {
        order.push("handler");
        const body = await request.json();
        return Response.json(body);
      },
    });
    const response = {
      body: "",
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: string) {
        this.body = body;
      },
      end() {},
    };

    await middleware(
      {
        method: "POST",
        url: "/protected",
        headers: { host: "example.com" },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
        body: {
          toJSON() {
            order.push("serialize");
            return { accepted: true };
          },
        },
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    expect(order).toEqual(["handler", "serialize"]);
  });

  it("returns an opaque non-cacheable error when lazy serialization fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const middleware = toNodeHandler({
      handler: async (request) => {
        await request.json();
        return new Response(null, { status: 204 });
      },
    });
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
        method: "POST",
        url: "/protected",
        headers: { host: "example.com" },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
        body: cyclic,
      },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(response.body)).toEqual({
      error: "Internal server error",
    });
    expect(response.body).not.toContain("circular");
    consoleError.mockRestore();
  });
});

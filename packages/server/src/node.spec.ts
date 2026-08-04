import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./index";
import { defineFirstPartyServerPlugin } from "./internal/first-party-plugin";
import { toNodeHandler } from "./node";
import { createRuntimeDatabase } from "./runtime.testFixtures";

type NodeResponseFixture = {
  body: string;
  statusCode: number;
  readonly headers: Map<string, string | string[]>;
  status(code: number): NodeResponseFixture;
  setHeader(name: string, value: string | string[]): void;
  send(body: string): void;
  end(): void;
};

function createNodeResponseFixture(): NodeResponseFixture {
  return {
    body: "",
    statusCode: 0,
    headers: new Map(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    send(body) {
      this.body = body;
    },
    end() {},
  };
}

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
    const response = createNodeResponseFixture();

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
    expect(response.headers.get("content-type")).toContain("application/json");
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
    const response = createNodeResponseFixture();

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
    const response = createNodeResponseFixture();

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
    const response = createNodeResponseFixture();

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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(response.body)).toEqual({
      error: "Internal server error",
    });
    expect(response.body).not.toContain("circular");
    consoleError.mockRestore();
  });

  it("does not expose a malformed streamed body through the real handler", async () => {
    const secret = "CREDENTIAL_SHOULD_NOT_LEAK";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const hotUpdater = createHotUpdater({
      basePath: "/hot-updater",
      database: createRuntimeDatabase(),
      plugins: [
        defineFirstPartyServerPlugin({
          id: "node-error-boundary",
          setup: () => ({}),
        }),
      ],
      routes: { bundles: true, updateCheck: false },
    });
    const middleware = toNodeHandler(hotUpdater);
    const response = createNodeResponseFixture();

    await middleware(
      {
        async *[Symbol.asyncIterator]() {
          yield secret;
        },
        method: "POST",
        url: "/hot-updater/api/bundles",
        headers: {
          "content-type": "application/json",
          host: "example.com",
        },
        protocol: "https",
        get: (name: string) => (name === "host" ? "example.com" : undefined),
      },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(response.body)).toEqual({
      error: "Internal server error",
    });
    expect(response.body).not.toContain(secret);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(secret);
    consoleError.mockRestore();
  });
});

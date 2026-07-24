import { describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import { compilePostAuthMiddleware } from "./middlewareDag";
import { compileRoutes } from "./routeCompiler";

const route = (
  options: Partial<HotUpdaterServerRoute<undefined>> = {},
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "public" },
  id: "route",
  method: "POST",
  path: "/route",
  async handle() {
    return new Response("handled");
  },
  ...options,
});

const streamRequest = (declaredLength?: string) => {
  const cancel = vi.fn();
  const pull = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel,
    pull(controller) {
      pull();
      controller.enqueue(new Uint8Array([1, 2]));
    },
  });
  const headers =
    declaredLength === undefined
      ? undefined
      : { "content-length": declaredLength };
  const init: RequestInit & { readonly duplex: "half" } = {
    body,
    duplex: "half",
    headers,
    method: "POST",
  };
  return {
    cancel,
    pull,
    request: new Request("https://example.com/api/route", init),
  };
};

const authenticatedProvider = (): HotUpdaterAuthenticationProvider => ({
  id: "auth",
  async authenticate() {
    return {
      kind: "authenticated",
      principal: { issuer: "issuer", subject: "subject" },
    };
  },
});

describe("executeKernelRequest", () => {
  it("rejects a declared overflow before authentication or body access", async () => {
    // Given
    const source = streamRequest("2");
    const authentication = authenticatedProvider();
    const authenticate = vi.spyOn(authentication, "authenticate");
    const router = compileRoutes([
      route({
        access: { kind: "protected" },
        requestPolicy: { maximumBodyBytes: 1 },
      }),
    ]);

    // When
    const response = await executeKernelRequest({
      authentication,
      basePath: "/api",
      middleware: [],
      request: source.request,
      router,
    });

    // Then
    expect(response.status).toBe(413);
    expect(authenticate).not.toHaveBeenCalled();
    expect(source.request.bodyUsed).toBe(false);
  });

  it("does not install a body reader when authentication denies access", async () => {
    // Given
    const source = streamRequest();
    const router = compileRoutes([
      route({
        access: { kind: "protected" },
        requestPolicy: { maximumBodyBytes: 1 },
      }),
    ]);
    const authentication: HotUpdaterAuthenticationProvider = {
      id: "auth",
      async authenticate() {
        return { kind: "anonymous" };
      },
    };

    // When
    const response = await executeKernelRequest({
      authentication,
      basePath: "/api",
      middleware: [],
      request: source.request,
      router,
    });

    // Then
    expect(response.status).toBe(401);
    expect(source.request.bodyUsed).toBe(false);
  });

  it("maps actual post-auth body overflow to 413", async () => {
    // Given
    const source = streamRequest();
    const handle = vi.fn(async () => new Response("leaked"));
    const router = compileRoutes([
      route({
        access: { kind: "protected" },
        input: {
          async parse(request) {
            await request.arrayBuffer();
          },
        },
        requestPolicy: { maximumBodyBytes: 1 },
        handle,
      }),
    ]);

    // When
    const response = await executeKernelRequest({
      authentication: authenticatedProvider(),
      basePath: "/api",
      middleware: [],
      request: source.request,
      router,
    });

    // Then
    expect(response.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("uses one route-owned response for declared and actual overflow", async () => {
    // Given
    const requestPolicy = {
      maximumBodyBytes: 1,
      payloadTooLargeResponse: {
        body: { error: "Route-specific limit" },
        headers: { "x-overflow-owner": "route" },
        status: 413,
      },
    } as const;
    const declaredRouter = compileRoutes([route({ requestPolicy })]);
    const actualRouter = compileRoutes([
      route({
        input: {
          async parse(request) {
            await request.arrayBuffer();
          },
        },
        requestPolicy,
      }),
    ]);

    // When
    const declared = await executeKernelRequest({
      basePath: "/api",
      middleware: [],
      request: streamRequest("2").request,
      router: declaredRouter,
    });
    const actual = await executeKernelRequest({
      basePath: "/api",
      middleware: [],
      request: streamRequest().request,
      router: actualRouter,
    });

    // Then
    expect(declared.status).toBe(413);
    expect(actual.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "Route-specific limit" });
    expect(await actual.json()).toEqual({ error: "Route-specific limit" });
    expect(declared.headers.get("x-overflow-owner")).toBe("route");
    expect(actual.headers.get("x-overflow-owner")).toBe("route");
  });

  it("executes middleware before parsing and unwinds in reverse", async () => {
    // Given
    const order: string[] = [];
    const createMiddleware = (
      id: string,
      after?: readonly string[],
    ): HotUpdaterPostAuthMiddleware => ({
      after,
      id,
      phase: "post-auth",
      async handle(_context, next) {
        order.push(`${id}:enter`);
        const response = await next();
        order.push(`${id}:exit`);
        return response;
      },
    });
    const router = compileRoutes([
      route({
        input: {
          async parse() {
            order.push("parse");
          },
        },
        async handle() {
          order.push("handler");
          return new Response("done");
        },
      }),
    ]);

    // When
    const response = await executeKernelRequest({
      authentication: authenticatedProvider(),
      basePath: "/api",
      middleware: compilePostAuthMiddleware([
        createMiddleware("second", ["first"]),
        createMiddleware("first"),
      ]),
      request: new Request("https://example.com/api/route", {
        method: "POST",
      }),
      router,
    });

    // Then
    expect(response.status).toBe(200);
    expect(order).toEqual([
      "first:enter",
      "second:enter",
      "parse",
      "handler",
      "second:exit",
      "first:exit",
    ]);
  });

  it("returns opaque 404 and 500 responses", async () => {
    // Given
    const secret = "provider-secret";
    const router = compileRoutes([
      route({
        async handle() {
          throw new Error(secret);
        },
      }),
    ]);

    // When
    const missing = await executeKernelRequest({
      basePath: "/api",
      middleware: [],
      request: new Request("https://example.com/api/missing"),
      router,
    });
    const failed = await executeKernelRequest({
      basePath: "/api",
      middleware: [],
      request: new Request("https://example.com/api/route", {
        method: "POST",
      }),
      router,
    });

    // Then
    expect(missing.status).toBe(404);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(secret);
  });
});

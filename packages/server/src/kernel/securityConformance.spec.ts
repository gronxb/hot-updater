import { describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

const SECRET = "must-not-appear-4f079c";

const provider = (
  authenticate: () => Promise<unknown>,
): HotUpdaterAuthenticationProvider => {
  const value: HotUpdaterAuthenticationProvider = {
    id: "auth",
    async authenticate() {
      return { kind: "anonymous" };
    },
  };
  Reflect.set(value, "authenticate", vi.fn(authenticate));
  return value;
};

const authenticatedProvider = (): HotUpdaterAuthenticationProvider =>
  provider(async () => ({
    kind: "authenticated",
    principal: { issuer: "issuer", subject: "subject" },
  }));

const trackedRequest = (
  chunks: readonly Uint8Array[],
  declaredLength?: string,
) => {
  const cancel = vi.fn();
  const pull = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      cancel,
      pull(controller) {
        pull();
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
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
    request: new Request("https://example.com/api/protected", init),
  };
};

const route = (
  options: Partial<HotUpdaterServerRoute<undefined>> = {},
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  path: "/protected",
  async handle() {
    return new Response(null, { status: 204 });
  },
  ...options,
});

describe("security conformance: authentication and body denial", () => {
  it.each([
    ["anonymous", async () => ({ kind: "anonymous" }), 401],
    ["unavailable", async () => ({ kind: "unavailable" }), 503],
    ["provider throw", async () => Promise.reject(new Error(SECRET)), 500],
    [
      "invalid principal accessor",
      async () => ({
        kind: "authenticated",
        principal: Object.defineProperty({ issuer: "issuer" }, "subject", {
          enumerable: true,
          get() {
            throw new Error(SECRET);
          },
        }),
      }),
      500,
    ],
  ])(
    "leaves the body and every downstream dependency untouched for %s",
    async (_name, authenticate, expectedStatus) => {
      // Given
      const source = trackedRequest([new Uint8Array([1, 2])], "invalid");
      const parse = vi.fn(async () => undefined);
      const database = vi.fn();
      const storage = vi.fn();
      const handle = vi.fn(async () => {
        database();
        storage();
        return new Response(SECRET);
      });
      const middleware = vi.fn();
      const router = compileRoutes([
        route({
          handle,
          input: { parse },
          requestPolicy: { maximumBodyBytes: 1 },
        }),
      ]);

      // When
      const response = await executeKernelRequest({
        authentication: provider(authenticate),
        basePath: "/api",
        middleware: [
          {
            id: "after-auth",
            phase: "post-auth",
            async handle(_context, next) {
              middleware();
              return next();
            },
          },
        ],
        request: source.request,
        router,
      });

      // Then
      expect(response.status).toBe(expectedStatus);
      expect(await response.text()).not.toContain(SECRET);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(source.request.bodyUsed).toBe(false);
      expect(source.pull).not.toHaveBeenCalled();
      expect(source.cancel).not.toHaveBeenCalled();
      expect([middleware, parse, handle, database, storage]).toSatisfy(
        (spies: readonly ReturnType<typeof vi.fn>[]) =>
          spies.every((spy) => spy.mock.calls.length === 0),
      );
    },
  );

  it("rejects a declared overflow before authentication and body access", async () => {
    // Given
    const source = trackedRequest([new Uint8Array([1])], "4");
    const authentication = authenticatedProvider();
    const authenticate = vi.spyOn(authentication, "authenticate");
    const handle = vi.fn(async () => new Response(SECRET));
    const router = compileRoutes([
      route({ handle, requestPolicy: { maximumBodyBytes: 3 } }),
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
    expect(handle).not.toHaveBeenCalled();
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.request.bodyUsed).toBe(false);
  });

  it("counts actual post-auth bytes independently of the declared length", async () => {
    // Given
    const source = trackedRequest(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      "1",
    );
    const parse = vi.fn(async (request: Request) => {
      await request.arrayBuffer();
      return undefined;
    });
    const handle = vi.fn(async () => new Response(SECRET));
    const router = compileRoutes([
      route({
        handle,
        input: { parse },
        requestPolicy: { maximumBodyBytes: 3 },
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
    expect(parse).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce();
  });
});

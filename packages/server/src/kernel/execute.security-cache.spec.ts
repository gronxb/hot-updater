import { describe, expect, it } from "vitest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterServerRoute,
} from "./contracts";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

const PRIVATE_CACHE_CONTROL = "private, no-store";
const SECRET = "protected-route-secret";

const authenticatedProvider = (): HotUpdaterAuthenticationProvider => ({
  id: "auth",
  async authenticate() {
    return {
      kind: "authenticated",
      principal: { issuer: "issuer", subject: "subject" },
    };
  },
});

const protectedRoute = (
  options: Partial<HotUpdaterServerRoute<undefined>> = {},
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "protected" },
  id: "protected-route",
  method: "GET",
  path: "/protected",
  async handle() {
    return new Response("handled");
  },
  ...options,
});

const executeProtectedRoute = (
  route: HotUpdaterServerRoute<undefined>,
  middleware: readonly HotUpdaterPostAuthMiddleware[] = [],
  request: Request = new Request("https://example.com/api/protected"),
) =>
  executeKernelRequest({
    authentication: authenticatedProvider(),
    basePath: "/api",
    middleware,
    request,
    router: compileRoutes([route]),
  });

const expectOpaqueProtectedFailure = async (
  response: Response,
): Promise<void> => {
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
  await expect(response.json()).resolves.toEqual({
    error: "Internal server error",
  });
};

describe("protected route response security", () => {
  it("prevents caching a declared-length rejection before authentication", async () => {
    // Given
    const route = protectedRoute({
      method: "POST",
      requestPolicy: { maximumBodyBytes: 1 },
    });
    const request = new Request("https://example.com/api/protected", {
      body: "secret",
      headers: { "content-length": "6" },
      method: "POST",
    });

    // When
    const response = await executeProtectedRoute(route, [], request);

    // Then
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    await expect(response.json()).resolves.toEqual({
      error: "Payload too large",
    });
  });

  it("returns an opaque non-cacheable response when a parser throws", async () => {
    // Given
    const route = protectedRoute({
      input: {
        async parse() {
          throw new Error(SECRET);
        },
      },
    });

    // When
    const response = await executeProtectedRoute(route);

    // Then
    await expectOpaqueProtectedFailure(response);
  });

  it("returns an opaque non-cacheable response when middleware throws", async () => {
    // Given
    const middleware: HotUpdaterPostAuthMiddleware = {
      id: "throwing-middleware",
      phase: "post-auth",
      async handle() {
        throw new Error(SECRET);
      },
    };

    // When
    const response = await executeProtectedRoute(protectedRoute(), [
      middleware,
    ]);

    // Then
    await expectOpaqueProtectedFailure(response);
  });

  it("returns an opaque non-cacheable response when a handler throws", async () => {
    // Given
    const route = protectedRoute({
      async handle() {
        throw new Error(SECRET);
      },
    });

    // When
    const response = await executeProtectedRoute(route);

    // Then
    await expectOpaqueProtectedFailure(response);
  });

  it("secures the outer fallback after a protected route matches", async () => {
    // Given
    const request = new Proxy(
      new Request("https://example.com/api/protected"),
      {
        get(target, property) {
          if (property === "signal") throw new Error(SECRET);
          return Reflect.get(target, property, target);
        },
      },
    );

    // When
    const response = await executeProtectedRoute(protectedRoute(), [], request);

    // Then
    await expectOpaqueProtectedFailure(response);
  });

  it("preserves public response cache semantics", async () => {
    // Given
    const route: HotUpdaterServerRoute<undefined> = {
      access: { kind: "public" },
      id: "public-route",
      method: "GET",
      path: "/public",
      async handle() {
        return new Response("public", {
          headers: { "cache-control": "public, max-age=60" },
        });
      },
    };

    // When
    const response = await executeKernelRequest({
      basePath: "/api",
      middleware: [],
      request: new Request("https://example.com/api/public"),
      router: compileRoutes([route]),
    });

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

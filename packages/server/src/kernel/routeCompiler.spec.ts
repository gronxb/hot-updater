import { describe, expect, it } from "vitest";

import type { HotUpdaterServerRoute } from "./contracts";
import { HotUpdaterConstructionError } from "./errors";
import { compileRoutes, matchCompiledRoute } from "./routeCompiler";

const route = (
  id: string,
  path: `/${string}`,
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "public" },
  id,
  method: "GET",
  path,
  async handle() {
    return new Response(id);
  },
});

const constructionCode = (callback: () => unknown): string | undefined => {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof HotUpdaterConstructionError
      ? error.code
      : undefined;
  }
};

describe("compileRoutes", () => {
  it("rejects duplicate IDs and canonical parameter routes", () => {
    // Given
    const duplicateIds = [route("same", "/a"), route("same", "/b")];
    const canonicalCollision = [
      route("first", "/x/:id"),
      route("second", "/x/:name"),
    ];

    // When / Then
    expect(constructionCode(() => compileRoutes(duplicateIds))).toBe(
      "DUPLICATE_ROUTE_ID",
    );
    expect(constructionCode(() => compileRoutes(canonicalCollision))).toBe(
      "DUPLICATE_ROUTE",
    );
  });

  it.each([
    [route("parameter", "/items/:id"), route("static", "/items/channels")],
    [route("static", "/items/channels"), route("parameter", "/items/:id")],
  ])("gives static segments precedence in either input order", (...routes) => {
    // Given
    const compiled = compileRoutes(routes);

    // When
    const match = matchCompiledRoute({
      basePath: "/api",
      method: "GET",
      pathname: "/api/items/channels",
      router: compiled,
    });

    // Then
    expect(match?.descriptor.id).toBe("static");
    expect(Object.isFrozen(compiled.routes)).toBe(true);
    expect(Object.isFrozen(match?.descriptor.params)).toBe(true);
  });

  it("matches only a segment-boundary base path and applies it once", () => {
    // Given
    const compiled = compileRoutes([route("version", "/version")]);

    // When
    const exact = matchCompiledRoute({
      basePath: "/api/",
      method: "GET",
      pathname: "/api/version",
      router: compiled,
    });
    const prefixSibling = matchCompiledRoute({
      basePath: "/api",
      method: "GET",
      pathname: "/apiary/version",
      router: compiled,
    });
    const repeated = matchCompiledRoute({
      basePath: "/api",
      method: "GET",
      pathname: "/api/api/version",
      router: compiled,
    });

    // Then
    expect(exact?.descriptor.pattern).toBe("/version");
    expect(prefixSibling).toBeUndefined();
    expect(repeated).toBeUndefined();
  });

  it("treats a malformed runtime path as no match", () => {
    // Given
    const compiled = compileRoutes([route("version", "/version")]);

    // When
    const match = matchCompiledRoute({
      basePath: "/api",
      method: "GET",
      pathname: "/api//version",
      router: compiled,
    });

    // Then
    expect(match).toBeUndefined();
  });

  it("copies and freezes mutable route policy objects", () => {
    // Given
    const access = { kind: "public" } as const;
    const body = { error: "too large" };
    const headers = { "content-type": "application/json" };
    const requestPolicy = {
      maximumBodyBytes: 10,
      payloadTooLargeResponse: {
        body,
        headers,
        status: 413,
      },
    } as const;
    const source: HotUpdaterServerRoute<undefined> = {
      ...route("post", "/post"),
      access,
      method: "POST",
      requestPolicy,
    };

    // When
    const compiled = compileRoutes([source]);
    Reflect.set(requestPolicy, "maximumBodyBytes", 20);
    body.error = "mutated";
    headers["content-type"] = "text/plain";

    // Then
    expect(compiled.routes[0]?.requestPolicy?.maximumBodyBytes).toBe(10);
    expect(compiled.routes[0]?.requestPolicy?.payloadTooLargeResponse).toEqual({
      body: { error: "too large" },
      headers: { "content-type": "application/json" },
      status: 413,
    });
    expect(Object.isFrozen(compiled.routes[0]?.access)).toBe(true);
    expect(Object.isFrozen(compiled.routes[0]?.requestPolicy)).toBe(true);
    expect(
      Object.isFrozen(
        compiled.routes[0]?.requestPolicy?.payloadTooLargeResponse?.body,
      ),
    ).toBe(true);
  });

  it("rejects a non-413 route-owned body policy response", () => {
    // Given
    const response = {
      body: { error: "not an error" },
      status: 413,
    } as const;
    Reflect.set(response, "status", 200);
    const source = {
      ...route("post", "/post"),
      method: "POST",
      requestPolicy: {
        maximumBodyBytes: 10,
        payloadTooLargeResponse: response,
      },
    } satisfies HotUpdaterServerRoute<undefined>;

    // When / Then
    expect(() => compileRoutes([source])).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
  });
});

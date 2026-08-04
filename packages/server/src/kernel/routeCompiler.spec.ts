import { describe, expect, it } from "vitest";

import type { HotUpdaterServerRoute } from "./contracts";
import { HotUpdaterConstructionError } from "./errors";
import { compileRoutes, matchCompiledRoute } from "./routeCompiler";

const route = (
  id: string,
  path: `/${string}`,
  method: HotUpdaterServerRoute["method"] = "GET",
): HotUpdaterServerRoute => ({
  access: { kind: "public" },
  id,
  method,
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
  it("rejects duplicate route IDs", () => {
    // Given
    const routes = [route("same", "/first"), route("same", "/second")];

    // When / Then
    expect(constructionCode(() => compileRoutes(routes))).toBe(
      "DUPLICATE_ROUTE_ID",
    );
  });

  it("rejects canonical method/path collisions with different parameter names", () => {
    // Given
    const routes = [
      route("first", "/items/:id"),
      route("second", "/items/:name"),
    ];

    // When / Then
    expect(constructionCode(() => compileRoutes(routes))).toBe(
      "DUPLICATE_ROUTE",
    );
  });

  it.each([
    [route("parameter", "/items/:id"), route("static", "/items/channels")],
    [route("static", "/items/channels"), route("parameter", "/items/:id")],
  ])(
    "gives static segments precedence independent of input order",
    (...routes) => {
      // Given
      const router = compileRoutes(routes);

      // When
      const match = matchCompiledRoute({
        basePath: "/api",
        method: "GET",
        pathname: "/api/items/channels",
        router,
      });

      // Then
      expect(match?.descriptor.id).toBe("static");
      expect(router.routes.map(({ id }) => id)).toEqual([
        "static",
        "parameter",
      ]);
    },
  );

  it("matches full configured and framework-stripped paths", () => {
    // Given
    const router = compileRoutes([route("version", "/version")]);

    // When
    const full = matchCompiledRoute({
      basePath: "/api/",
      method: "GET",
      pathname: "/api/version",
      router,
    });
    const stripped = matchCompiledRoute({
      basePath: "/api/",
      method: "GET",
      pathname: "/version",
      router,
    });

    // Then
    expect(full?.descriptor.id).toBe("version");
    expect(stripped?.descriptor.id).toBe("version");
  });

  it("matches a stripped route whose own path begins with the base path", () => {
    // Given
    const router = compileRoutes([route("bundles", "/api/bundles", "POST")]);

    // When
    const full = matchCompiledRoute({
      basePath: "/api",
      method: "POST",
      pathname: "/api/api/bundles",
      router,
    });
    const stripped = matchCompiledRoute({
      basePath: "/api",
      method: "POST",
      pathname: "/api/bundles",
      router,
    });

    // Then
    expect(full?.descriptor.id).toBe("bundles");
    expect(stripped?.descriptor.id).toBe("bundles");
  });

  it("returns frozen parameters using the declared parameter names", () => {
    // Given
    const router = compileRoutes([route("item", "/items/:itemId")]);

    // When
    const match = matchCompiledRoute({
      basePath: "/api",
      method: "GET",
      pathname: "/items/abc",
      router,
    });

    // Then
    expect(match?.descriptor.params).toEqual({ itemId: "abc" });
    expect(Object.isFrozen(match?.descriptor.params)).toBe(true);
  });
});

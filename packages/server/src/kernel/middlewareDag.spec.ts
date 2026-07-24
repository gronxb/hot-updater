import { describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRequestExecutionContext,
} from "./contracts";
import {
  compilePostAuthMiddleware,
  executePostAuthMiddleware,
} from "./middlewareDag";

const middleware = (
  id: string,
  options: {
    readonly after?: readonly string[];
    readonly before?: readonly string[];
  } = {},
): HotUpdaterPostAuthMiddleware => ({
  ...options,
  id,
  phase: "post-auth",
  async handle(_context, next) {
    return next();
  },
});

const context: HotUpdaterRequestExecutionContext = {
  principal: undefined,
  route: {
    access: { kind: "public" },
    id: "route",
    method: "GET",
    params: {},
    pattern: "/route",
  },
};

describe("compilePostAuthMiddleware", () => {
  it("uses lexical order for independent nodes", () => {
    // Given / When
    const compiled = compilePostAuthMiddleware([
      middleware("charlie"),
      middleware("alpha"),
      middleware("bravo"),
    ]);

    // Then
    expect(compiled.map((item) => item.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it("resolves before and after edges independent of input order", () => {
    // Given / When
    const compiled = compilePostAuthMiddleware([
      middleware("last", { after: ["middle"] }),
      middleware("first", { before: ["middle"] }),
      middleware("middle"),
    ]);

    // Then
    expect(compiled.map((item) => item.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
  });

  it.each([
    [[middleware("same"), middleware("same")], "DUPLICATE_MIDDLEWARE_ID"],
    [
      [middleware("known", { after: ["missing"] })],
      "UNKNOWN_MIDDLEWARE_DEPENDENCY",
    ],
    [
      [
        middleware("alpha", { after: ["bravo"] }),
        middleware("bravo", { after: ["alpha"] }),
      ],
      "MIDDLEWARE_DEPENDENCY_CYCLE",
    ],
  ])("rejects invalid graph %#", (items, code) => {
    // Given / When / Then
    expect(() => compilePostAuthMiddleware(items)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

describe("executePostAuthMiddleware", () => {
  it("normalizes a response created before the global constructor changes", async () => {
    // Given
    const response = new Response("cross-constructor");
    const originalResponse = globalThis.Response;
    class RuntimeResponse extends originalResponse {}
    globalThis.Response = RuntimeResponse;

    try {
      // When
      const normalized = await executePostAuthMiddleware({
        context,
        handler: async () => response,
        middleware: [],
      });

      // Then
      expect(normalized).toBeInstanceOf(RuntimeResponse);
      expect(normalized.status).toBe(200);
      await expect(normalized.text()).resolves.toBe("cross-constructor");
    } finally {
      globalThis.Response = originalResponse;
    }
  });

  it.each(["concurrent", "sequential"])(
    "returns an opaque 500 when next is called %sly",
    async (mode) => {
      // Given
      const handler = vi.fn(async () => new Response("secret"));
      const invalid: HotUpdaterPostAuthMiddleware = {
        id: "invalid",
        phase: "post-auth",
        async handle(_context, next) {
          if (mode === "concurrent") {
            await Promise.all([next(), next()]);
          } else {
            await next();
            await next();
          }
          return new Response("leaked");
        },
      };

      // When
      const response = await executePostAuthMiddleware({
        context,
        handler,
        middleware: [invalid],
      });

      // Then
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret");
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("does not dispatch after middleware has already returned", async () => {
    // Given
    const handler = vi.fn(async () => new Response("late"));
    let lateNext: (() => Promise<Response>) | undefined;
    const shortCircuit: HotUpdaterPostAuthMiddleware = {
      id: "short-circuit",
      phase: "post-auth",
      async handle(_context, next) {
        lateNext = next;
        return new Response("done");
      },
    };

    // When
    const response = await executePostAuthMiddleware({
      context,
      handler,
      middleware: [shortCircuit],
    });
    const lateResponse = lateNext === undefined ? undefined : await lateNext();

    // Then
    expect(await response.text()).toBe("done");
    expect(lateResponse?.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });
});

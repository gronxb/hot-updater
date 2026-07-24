import { APIError, betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateMatchedRoute } from "../../server/src/kernel/authentication";
import type { HotUpdaterMatchedRoute } from "../../server/src/kernel/contracts";
import betterAuthPackage from "../node_modules/better-auth/package.json";
import { betterAuthPlugin } from "./index";

const SECRET = "pinned-session-store-secret-e215";
const setupContext = {
  capabilities: {
    get: () => undefined,
    require() {
      throw new Error("unexpected capability access");
    },
  },
  diagnostics: { warn() {} },
};
const route: HotUpdaterMatchedRoute = {
  access: { kind: "protected" },
  id: "protected",
  method: "GET",
  params: {},
  pattern: "/protected",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Auth 1.6.24 session-store fault characterization", () => {
  it("keeps the locked upstream outage classification opaque", async () => {
    // Given
    expect(betterAuthPackage.version).toBe("1.6.24");
    const database: MemoryDB = {
      account: [],
      session: [],
      user: [],
      verification: [],
    };
    const createMemoryAdapter = memoryAdapter(database);
    let sessionStoreAvailable = true;
    const upstreamError = Object.assign(new Error(SECRET), { status: 503 });
    const auth = betterAuth({
      baseURL: "https://example.com",
      database(options: Parameters<typeof createMemoryAdapter>[0]) {
        const adapter = createMemoryAdapter(options);
        return {
          ...adapter,
          async findOne(input: Parameters<typeof adapter.findOne>[0]) {
            if (!sessionStoreAvailable && input.model === "session") {
              throw upstreamError;
            }
            return adapter.findOne(input);
          },
        };
      },
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      secret: "locked-version-characterization-secret-32-bytes",
    });
    const registration = await auth.api.signUpEmail({
      body: {
        email: "pinned@example.com",
        name: "Pinned Version",
        password: "bounded-characterization-password",
      },
      returnHeaders: true,
    });
    const cookie =
      registration.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(cookie).not.toBe("");
    const headers = new Headers({ cookie });
    const contribution = betterAuthPlugin({ auth }).setup(setupContext);
    const provider = contribution.authentication;
    expect(provider).toBeDefined();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warnLog = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    sessionStoreAvailable = false;

    // When
    const direct = await Promise.allSettled([
      auth.api.getSession({ headers: new Headers(headers) }),
    ]);
    const kernel =
      provider === undefined
        ? undefined
        : await authenticateMatchedRoute({
            headers,
            provider,
            route,
            signal: new AbortController().signal,
            url: new URL("https://example.com/protected"),
          });

    // Then
    const directResult = direct[0];
    expect(directResult?.status).toBe("rejected");
    if (directResult?.status === "rejected") {
      expect(directResult.reason).toBeInstanceOf(APIError);
      if (directResult.reason instanceof APIError) {
        expect(upstreamError.status).toBe(503);
        expect(directResult.reason.status).toBe("INTERNAL_SERVER_ERROR");
        expect(directResult.reason.statusCode).toBe(500);
        expect(String(directResult.reason)).not.toContain(SECRET);
        expect(JSON.stringify(directResult.reason)).not.toContain(SECRET);
      }
    }
    expect(kernel?.kind).toBe("response");
    if (kernel?.kind === "response") {
      expect(kernel.response.status).toBe(500);
      expect(await kernel.response.json()).toEqual({
        error: "Internal server error",
      });
    }
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });
});

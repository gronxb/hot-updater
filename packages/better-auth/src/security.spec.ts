import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateMatchedRoute } from "../../server/src/kernel/authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
} from "../../server/src/kernel/contracts";
import { betterAuthPlugin, type BetterAuthConfiguredInstance } from "./index";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const SECRET = "better-auth-secret-b6c2";
const route: HotUpdaterMatchedRoute = {
  access: { kind: "protected" },
  id: "protected",
  method: "POST",
  params: {},
  pattern: "/protected",
};

const isAuthenticationProvider = (
  value: unknown,
): value is HotUpdaterAuthenticationProvider =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "authenticate") === "function" &&
  typeof Reflect.get(value, "id") === "string";

const providerFrom = (
  auth: BetterAuthConfiguredInstance,
): HotUpdaterAuthenticationProvider => {
  const contribution = betterAuthPlugin({ auth }).setup(
    createPluginSetupContext(),
  );
  if (typeof contribution !== "object" || contribution === null) {
    throw new Error("invalid authentication contribution");
  }
  const provider = Reflect.get(contribution, "authentication");
  if (!isAuthenticationProvider(provider)) {
    throw new Error("missing authentication contribution");
  }
  return provider;
};

const kernelAuthentication = (auth: BetterAuthConfiguredInstance) =>
  authenticateMatchedRoute({
    headers: new Headers(),
    provider: providerFrom(auth),
    route,
    signal: new AbortController().signal,
    url: new URL("https://example.com/protected"),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Auth security boundaries", () => {
  it("turns an unexpected provider failure into an opaque kernel response", async () => {
    const unexpected = Object.freeze({
      code: "UNEXPECTED",
      message: SECRET,
      status: 500,
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          throw unexpected;
        },
      },
    };

    const result = await kernelAuthentication(auth);

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(500);
      expect(result.response.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(await result.response.text()).not.toContain(SECRET);
    }
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { id: undefined },
    { id: null },
    { id: 503 },
    { id: "" },
    { id: " padded " },
    Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    }),
  ])("rejects malformed session user %# without leaking it", async (user) => {
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          return null;
        },
      },
    };
    Reflect.set(auth.api, "getSession", async () => ({ session: {}, user }));

    const result = await kernelAuthentication(auth);

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(500);
      expect(await result.response.text()).not.toContain(SECRET);
    }
  });

  it("does not read the Better Auth handler", () => {
    const handlerRead = vi.fn();
    const auth: BetterAuthConfiguredInstance = {
      api: { getSession: vi.fn(async () => null) },
    };
    Object.defineProperty(auth, "handler", {
      enumerable: true,
      get() {
        handlerRead();
        return SECRET;
      },
    });

    betterAuthPlugin({ auth }).setup(createPluginSetupContext());

    expect(handlerRead).not.toHaveBeenCalled();
  });
});

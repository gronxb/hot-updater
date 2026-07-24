import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateMatchedRoute } from "../../server/src/kernel/authentication";
import type {
  HotUpdaterAuthenticationInput,
  HotUpdaterMatchedRoute,
} from "../../server/src/kernel/contracts";
import { betterAuthPlugin, type BetterAuthConfiguredInstance } from "./index";

const SECRET = "better-auth-secret-b6c2";
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
  method: "POST",
  params: {},
  pattern: "/protected",
};

const authenticationInput = (): HotUpdaterAuthenticationInput => ({
  headers: new Headers({
    authorization: `Bearer ${SECRET}`,
    cookie: `session=${SECRET}`,
  }),
  method: "POST",
  route,
  signal: new AbortController().signal,
  url: new URL("https://example.com/protected"),
});

const authReturning = (value: unknown): BetterAuthConfiguredInstance => {
  const auth: BetterAuthConfiguredInstance = {
    api: {
      async getSession() {
        return null;
      },
    },
  };
  Reflect.set(
    auth.api,
    "getSession",
    vi.fn(async () => value),
  );
  return auth;
};

const providerFrom = (auth: BetterAuthConfiguredInstance) => {
  const manifest = betterAuthPlugin({ auth });
  const contribution = manifest.setup(setupContext);
  const provider = contribution.authentication;
  if (provider === undefined) {
    throw new Error("missing authentication contribution");
  }
  return { contribution, manifest, provider };
};

const kernelAuthentication = (auth: BetterAuthConfiguredInstance) =>
  authenticateMatchedRoute({
    headers: new Headers(),
    provider: providerFrom(auth).provider,
    route,
    signal: new AbortController().signal,
    url: new URL("https://example.com/protected"),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Auth security conformance", () => {
  it("uses an immutable configured instance without mutating its options", async () => {
    // Given
    const receivers = new WeakSet<object>();
    const getSession: BetterAuthConfiguredInstance["api"]["getSession"] =
      async function getSessionWithReceiver(
        this: BetterAuthConfiguredInstance["api"],
      ) {
        receivers.add(this);
        return null;
      };
    const api = Object.freeze({ getSession });
    const auth: BetterAuthConfiguredInstance = Object.freeze({ api });
    const options = Object.freeze({ auth });
    const authDescriptors = Object.getOwnPropertyDescriptors(auth);
    const apiDescriptors = Object.getOwnPropertyDescriptors(api);

    // When
    const result = await betterAuthPlugin(options)
      .setup(setupContext)
      .authentication?.authenticate(authenticationInput());

    // Then
    expect(result).toEqual({ kind: "anonymous" });
    expect(Reflect.ownKeys(result ?? {})).toEqual(["kind"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(receivers.has(api)).toBe(true);
    expect(Object.getOwnPropertyDescriptors(auth)).toEqual(authDescriptors);
    expect(Object.getOwnPropertyDescriptors(api)).toEqual(apiDescriptors);
  });

  it("passes only cloned headers and no body-capable request surface", async () => {
    // Given
    const received: object[] = [];
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession(input) {
          received.push(input);
          input.headers.set("authorization", "mutated");
          input.headers.set("x-provider", SECRET);
          return null;
        },
      },
    };
    const input = authenticationInput();
    const originalUrl = input.url.toString();

    // When
    const result = await providerFrom(auth).provider.authenticate(input);

    // Then
    expect(result).toEqual({ kind: "anonymous" });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toBeInstanceOf(Request);
    expect(Reflect.ownKeys(received[0] ?? {})).toEqual(["headers"]);
    for (const prohibited of "body json request route signal text url".split(
      " ",
    )) {
      expect(Reflect.has(received[0] ?? {}, prohibited)).toBe(false);
    }
    expect(input.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(input.headers.has("x-provider")).toBe(false);
    expect(input.url.toString()).toBe(originalUrl);
  });

  it("copies only user.id and drops session, cookie, key, and profile extras", async () => {
    // Given
    const source = {
      session: {
        apiKey: SECRET,
        cookie: SECRET,
        token: SECRET,
      },
      user: {
        apiKey: SECRET,
        email: `${SECRET}@example.com`,
        id: "user-123",
        name: SECRET,
      },
    };
    const auth = authReturning(source);

    // When
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );
    source.user.id = "mutated";

    // Then
    expect(result).toEqual({
      kind: "authenticated",
      principal: { issuer: "better-auth", subject: "user-123" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === "authenticated") {
      expect(Object.isFrozen(result.principal)).toBe(true);
      expect(Reflect.ownKeys(result.principal).sort()).toEqual([
        "issuer",
        "subject",
      ]);
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    { status: 503 },
    { statusCode: 503 },
    { status: "SERVICE_UNAVAILABLE" },
  ])("normalizes an observable outage marker", async (outage) => {
    // Given
    const auth: BetterAuthConfiguredInstance = {
      api: {
        async getSession() {
          throw outage;
        },
      },
    };

    // When
    const result = await providerFrom(auth).provider.authenticate(
      authenticationInput(),
    );

    // Then
    expect(result).toEqual({ kind: "unavailable" });
    expect(Reflect.ownKeys(result)).toEqual(["kind"]);
  });

  it("rethrows unexpected secrets without logging or returning provider data", async () => {
    // Given
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
    const provider = providerFrom(auth).provider;

    // When
    const direct = provider.authenticate(authenticationInput());
    const kernel = await kernelAuthentication(auth);

    // Then
    await expect(direct).rejects.toBe(unexpected);
    expect(kernel.kind).toBe("response");
    if (kernel.kind === "response") {
      expect(kernel.response.status).toBe(500);
      expect(await kernel.response.text()).not.toContain(SECRET);
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
  ])(
    "fails malformed session user %# safely through the kernel",
    async (user) => {
      // Given
      const auth = authReturning({ session: {}, user });

      // When
      const result = await kernelAuthentication(auth);

      // Then
      expect(result.kind).toBe("response");
      if (result.kind === "response") {
        expect(result.response.status).toBe(500);
        expect(await result.response.text()).not.toContain(SECRET);
      }
    },
  );

  it("does not expose protection callbacks or Better Auth handler routes", () => {
    // Given
    const handlerRead = vi.fn();
    const auth = authReturning(null);
    Object.defineProperty(auth, "handler", {
      enumerable: true,
      get() {
        handlerRead();
        return SECRET;
      },
    });

    // When
    const { contribution, manifest, provider } = providerFrom(auth);

    // Then
    for (const surface of [manifest, contribution, provider]) {
      expect(Reflect.has(surface, "authorize")).toBe(false);
      expect(Reflect.has(surface, "handler")).toBe(false);
      expect(Reflect.has(surface, "protect")).toBe(false);
      expect(Reflect.has(surface, "routes")).toBe(false);
    }
    expect(Reflect.ownKeys(contribution)).toEqual(["authentication"]);
    expect(handlerRead).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import { betterAuthPlugin } from "./index";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const authenticationInput = (headers: HeadersInit = {}) => ({
  headers: new Headers(headers),
  method: "POST" as const,
  route: {
    access: { kind: "protected" as const },
    id: "protected",
    method: "POST" as const,
    params: Object.freeze({}),
    pattern: "/protected" as const,
  },
  signal: new AbortController().signal,
  url: new URL("https://example.com/protected"),
});

const createApiKeyAuth = (
  verifyApiKey: (input: {
    readonly body: {
      readonly configId?: string;
      readonly key: string;
      readonly permissions?: Readonly<Record<string, readonly string[]>>;
    };
  }) => Promise<unknown>,
) => ({
  api: {
    getSession: vi.fn(async () => null),
    verifyApiKey: vi.fn(verifyApiKey),
  },
});

const providerFromApiKey = (options: {
  readonly apiKey: {
    readonly configId: string;
    readonly headerName?: string;
    readonly requiredPermissions?: Readonly<Record<string, readonly string[]>>;
  };
  readonly auth: ReturnType<typeof createApiKeyAuth>;
}) => {
  const manifest = betterAuthPlugin(options);
  const contribution = manifest.setup(createPluginSetupContext());
  const provider = contribution.authentication;
  if (provider === undefined) {
    throw new Error("Better Auth did not contribute authentication.");
  }
  return { contribution, provider };
};

describe("betterAuthPlugin API-key mode", () => {
  it("authenticates the x-api-key header through verifyApiKey", async () => {
    // Given
    const auth = createApiKeyAuth(async () => ({
      error: null,
      key: { id: "stored-key-id", referenceId: "mobile-client" },
      valid: true,
    }));
    const { provider } = providerFromApiKey({
      apiKey: { configId: "mobile" },
      auth,
    });

    // When
    const result = await provider.authenticate(
      authenticationInput({ "x-api-key": "client-key" }),
    );

    // Then
    expect(auth.api.verifyApiKey).toHaveBeenCalledWith({
      body: { configId: "mobile", key: "client-key" },
    });
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "authenticated",
      principal: {
        issuer: "better-auth-api-key",
        subject: "mobile-client",
      },
    });
  });

  it("accepts a configured instance that exposes only verifyApiKey", () => {
    // Given
    const auth = {
      api: {
        async verifyApiKey() {
          return { error: null, key: null, valid: false };
        },
      },
    };

    // When
    const manifest = betterAuthPlugin({
      apiKey: { configId: "mobile" },
      auth,
    });

    // Then
    expect(manifest.namespace).toBe("better-auth");
  });

  it("forwards configured key scope without adding request data", async () => {
    // Given
    const auth = createApiKeyAuth(async () => ({
      error: null,
      key: { id: "stored-key-id", referenceId: "release-client" },
      valid: true,
    }));
    const permissions = {
      releases: ["read"],
    } as const;
    const { provider } = providerFromApiKey({
      apiKey: {
        configId: "mobile",
        headerName: "x-release-key",
        requiredPermissions: permissions,
      },
      auth,
    });

    // When
    await provider.authenticate(
      authenticationInput({
        authorization: "must-not-cross",
        "x-release-key": "scoped-key",
      }),
    );

    // Then
    expect(auth.api.verifyApiKey).toHaveBeenCalledWith({
      body: {
        configId: "mobile",
        key: "scoped-key",
        permissions,
      },
    });
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "empty", value: "" },
    { name: "control", value: "key\u0001value" },
    { name: "comma", value: "first,second" },
    { name: "oversized", value: "k".repeat(4097) },
  ])(
    "rejects a $name credential before calling Better Auth",
    async ({ value }) => {
      // Given
      const auth = createApiKeyAuth(async () => ({
        error: null,
        key: { id: "stored-key-id", referenceId: "must-not-authenticate" },
        valid: true,
      }));
      const { provider } = providerFromApiKey({
        apiKey: { configId: "mobile" },
        auth,
      });
      const input =
        value === undefined
          ? authenticationInput()
          : authenticationInput({ "x-api-key": value });

      // When
      const result = await provider.authenticate(input);

      // Then
      expect(result).toEqual({ kind: "anonymous" });
      expect(auth.api.verifyApiKey).not.toHaveBeenCalled();
    },
  );

  it("maps a rejected Better Auth key to anonymous", async () => {
    // Given
    const auth = createApiKeyAuth(async () => ({
      error: { code: "KEY_NOT_FOUND" },
      key: null,
      valid: false,
    }));
    const { provider } = providerFromApiKey({
      apiKey: { configId: "mobile" },
      auth,
    });

    // When
    const result = await provider.authenticate(
      authenticationInput({ "x-api-key": "unknown-key" }),
    );

    // Then
    expect(result).toEqual({ kind: "anonymous" });
  });

  it.each([{ status: 503 }, { statusCode: 503 }])(
    "maps an observable verification outage to unavailable",
    async (outage) => {
      // Given
      const auth = createApiKeyAuth(async () => {
        throw outage;
      });
      const { provider } = providerFromApiKey({
        apiKey: { configId: "mobile" },
        auth,
      });

      // When
      const result = await provider.authenticate(
        authenticationInput({ "x-api-key": "client-key" }),
      );

      // Then
      expect(result).toEqual({ kind: "unavailable" });
      expect(auth.api.verifyApiKey).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    {},
    { referenceId: null },
    { referenceId: "" },
    { referenceId: " padded " },
    { referenceId: 503 },
  ])("fails closed for malformed verified key %#", async (key) => {
    // Given
    const auth = createApiKeyAuth(async () => ({
      error: null,
      key,
      valid: true,
    }));
    const { provider } = providerFromApiKey({
      apiKey: { configId: "mobile" },
      auth,
    });

    // When
    const pending = provider.authenticate(
      authenticationInput({ "x-api-key": "client-key" }),
    );

    // Then
    await expect(pending).rejects.toThrow();
  });
});

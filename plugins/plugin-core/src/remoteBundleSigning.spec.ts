import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signWithPrivateKey,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createBundleSigningHandler,
  createRemoteBundleSigningPlugin,
  REMOTE_BUNDLE_SIGNING_ALGORITHM,
  REMOTE_BUNDLE_SIGNING_PATH,
  REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
  REMOTE_BUNDLE_SIGNING_TOKEN_HEADER,
} from "./remoteBundleSigning";

const TOKEN = "dedicated-signing-token";
const ENDPOINT = "https://updates.example.com/functions/v1/update-server";
const ENDPOINT_PATH = `/functions/v1/update-server${REMOTE_BUNDLE_SIGNING_PATH}`;
const PUBLIC_KEY_PATH = "keys/public-key.pem";

const createKeys = (modulusLength = 2048) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
  });
  const publicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const publicKeyDer = createPublicKey(publicKeyPem).export({
    format: "der",
    type: "spki",
  });
  return {
    keyId: createHash("sha256").update(publicKeyDer).digest("hex"),
    privateKey,
    publicKey: publicKeyPem,
  };
};

const keys = createKeys();
const message = new Uint8Array(32).fill(7);

const createServerFetch = ({
  publicKey = keys.publicKey,
  sign = (input: Uint8Array) =>
    signWithPrivateKey("RSA-SHA256", input, keys.privateKey),
  token = TOKEN,
}: {
  publicKey?: string;
  sign?: (input: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  token?: string;
} = {}) =>
  vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const response = await createBundleSigningHandler({
      endpointPath: ENDPOINT_PATH,
      publicKey,
      request: new Request(input, init),
      sign,
      token,
    });
    return response ?? new Response("not found", { status: 404 });
  });

const createPlugin = (fetch: typeof globalThis.fetch) =>
  createRemoteBundleSigningPlugin({
    endpoint: ENDPOINT,
    fetch,
    name: "edgeFunctionSigning",
    publicKeyPath: PUBLIC_KEY_PATH,
    resolveToken: () => TOKEN,
  });

const metadata = (overrides: Record<string, unknown> = {}) => ({
  algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
  keyId: keys.keyId,
  protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
  publicKey: keys.publicKey,
  ...overrides,
});

describe("remote bundle signing client", () => {
  it("round trips the fixed protocol through a prefixed provider URL", async () => {
    const fetch = createServerFetch();
    const plugin = createPlugin(fetch);

    await expect(plugin.getPublicKey()).resolves.toEqual({
      publicKey: keys.publicKey,
    });
    await expect(plugin.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(
        signWithPrivateKey("RSA-SHA256", message, keys.privateKey),
      ),
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetch.mock.calls[0]!;
    expect(String(getUrl)).toBe(`https://updates.example.com${ENDPOINT_PATH}`);
    expect(getInit).toMatchObject({ method: "GET", redirect: "error" });
    expect(getInit?.signal).toBeInstanceOf(AbortSignal);
    expect(
      new Headers(getInit?.headers).get(REMOTE_BUNDLE_SIGNING_TOKEN_HEADER),
    ).toBe(TOKEN);

    const [, postInit] = fetch.mock.calls[1]!;
    expect(JSON.parse(String(postInit?.body))).toEqual({
      algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
      keyId: keys.keyId,
      message: Buffer.from(message).toString("base64"),
      protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    });
  });

  it("caches valid metadata and retries after a redacted load failure", async () => {
    const serverFetch = createServerFetch();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(`upstream leaked ${TOKEN}`))
      .mockImplementation(serverFetch);
    const plugin = createPlugin(fetch);

    await expect(plugin.getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );
    await expect(plugin.getPublicKey()).resolves.toEqual({
      publicKey: keys.publicKey,
    });
    await expect(plugin.getPublicKey()).resolves.toEqual({
      publicKey: keys.publicKey,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "not a URL",
    "http://signer.example.com",
    "https://user:secret@signer.example.com",
    "https://signer.example.com/path?token=secret",
    "https://signer.example.com/path#fragment",
    "https://signer.example.com/a/../b",
    "https://signer.example.com/a/%2e%2e/b",
    "https://signer.example.com/a/%2f/b",
  ])("rejects unsafe endpoints without reflecting them: %s", (endpoint) => {
    expect(() =>
      createRemoteBundleSigningPlugin({
        endpoint,
        name: "remote",
        publicKeyPath: PUBLIC_KEY_PATH,
        resolveToken: () => TOKEN,
      }),
    ).toThrow("Remote bundle signing requires a valid endpoint.");
  });

  it("allows HTTP only for exact loopback hosts", () => {
    expect(() =>
      createRemoteBundleSigningPlugin({
        endpoint: "http://127.0.0.1:8787/provider",
        name: "remote",
        publicKeyPath: PUBLIC_KEY_PATH,
        resolveToken: () => TOKEN,
      }),
    ).not.toThrow();
    expect(() =>
      createRemoteBundleSigningPlugin({
        endpoint: "http://localhost:8787/provider",
        name: "remote",
        publicKeyPath: PUBLIC_KEY_PATH,
        resolveToken: () => TOKEN,
      }),
    ).not.toThrow();
  });

  it.each([
    metadata({ protocolVersion: 2 }),
    metadata({ algorithm: "RSA-PSS" }),
    metadata({ keyId: "0".repeat(64) }),
    { ...metadata(), extra: true },
  ])("rejects malformed metadata", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(body),
    );
    await expect(createPlugin(fetch).getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );
  });

  it("rejects unsupported RSA sizes and non-JSON or oversized responses", async () => {
    const weak = createKeys(1024);
    const weakFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(metadata({ keyId: weak.keyId, publicKey: weak.publicKey })),
    );
    await expect(createPlugin(weakFetch).getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );

    const textFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(metadata()), {
          headers: { "content-type": "text/plain" },
        }),
    );
    await expect(createPlugin(textFetch).getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );

    const oversizedFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "content-length": String(32 * 1024 + 1),
            "content-type": "application/json",
          },
        }),
    );
    await expect(createPlugin(oversizedFetch).getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );
  });

  it("validates POST response identity and verifies the signature locally", async () => {
    const invalidIdentityFetch = vi.fn<typeof globalThis.fetch>(
      async (input, init) => {
        if (init?.method === "GET") return Response.json(metadata());
        return Response.json({
          algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
          keyId: "0".repeat(64),
          protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
          signature: Buffer.from(
            signWithPrivateKey("RSA-SHA256", message, keys.privateKey),
          ).toString("base64"),
        });
      },
    );
    await expect(
      createPlugin(invalidIdentityFetch).sign({ message }),
    ).rejects.toThrow("invalid signature");

    const unverifiableFetch = vi.fn<typeof globalThis.fetch>(
      async (input, init) => {
        if (init?.method === "GET") return Response.json(metadata());
        return Response.json({
          algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
          keyId: keys.keyId,
          protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
          signature: Buffer.from(new Uint8Array(256).fill(1)).toString(
            "base64",
          ),
        });
      },
    );
    await expect(
      createPlugin(unverifiableFetch).sign({ message }),
    ).rejects.toThrow("unverifiable signature");
  });

  it("does not resolve credentials before an operation and redacts token errors", async () => {
    const resolveToken = vi.fn(() => {
      throw new Error(`missing ${TOKEN}`);
    });
    const plugin = createRemoteBundleSigningPlugin({
      endpoint: ENDPOINT,
      fetch: createServerFetch(),
      name: "remote",
      publicKeyPath: PUBLIC_KEY_PATH,
      resolveToken,
    });
    expect(resolveToken).not.toHaveBeenCalled();
    await expect(plugin.getPublicKey()).rejects.toThrow(
      "Failed to load the remote bundle signing public key.",
    );
    await expect(plugin.getPublicKey()).rejects.not.toThrow(TOKEN);
  });
});

describe("portable bundle signing handler", () => {
  const request = (
    method: string,
    body?: unknown,
    options: { path?: string; token?: string } = {},
  ) =>
    new Request(`https://updates.example.com${options.path ?? ENDPOINT_PATH}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        [REMOTE_BUNDLE_SIGNING_TOKEN_HEADER]: options.token ?? TOKEN,
      },
      method,
    });

  const callHandler = (
    input: Request,
    overrides: Partial<{
      endpointPath: string;
      publicKey: string;
      sign: (input: Uint8Array) => Uint8Array | Promise<Uint8Array>;
      token: string;
    }> = {},
  ) =>
    createBundleSigningHandler({
      endpointPath: ENDPOINT_PATH,
      publicKey: keys.publicKey,
      request: input,
      sign: (value) => signWithPrivateKey("RSA-SHA256", value, keys.privateKey),
      token: TOKEN,
      ...overrides,
    });

  it("returns null outside its exact trusted path", async () => {
    await expect(
      callHandler(
        request("GET", undefined, { path: REMOTE_BUNDLE_SIGNING_PATH }),
      ),
    ).resolves.toBeNull();
    await expect(
      callHandler(request("GET"), {
        endpointPath: "/prefix/../_hot-updater/signing",
      }),
    ).rejects.toThrow("valid endpoint path");
  });

  it("requires the dedicated signing token and never accepts the app API key", async () => {
    const unauthorized = await callHandler(
      new Request(`https://updates.example.com${ENDPOINT_PATH}`, {
        headers: { "x-api-key": TOKEN },
      }),
    );
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.headers.get("cache-control")).toBe(
      "private, no-store",
    );

    const wrong = await callHandler(
      request("GET", undefined, { token: "wrong-token" }),
    );
    expect(wrong?.status).toBe(401);
  });

  it.each([
    {
      algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
      keyId: keys.keyId,
      message: Buffer.from(new Uint8Array(31)).toString("base64"),
      protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    },
    {
      algorithm: "RSA-PSS",
      keyId: keys.keyId,
      message: Buffer.from(message).toString("base64"),
      protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    },
    {
      algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
      extra: true,
      keyId: keys.keyId,
      message: Buffer.from(message).toString("base64"),
      protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    },
    {
      algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
      keyId: keys.keyId,
      message: `${Buffer.from(message).toString("base64")}=`,
      protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    },
  ])(
    "rejects malformed signing requests before invoking sign",
    async (body) => {
      const sign = vi.fn();
      const response = await callHandler(request("POST", body), { sign });
      expect(response?.status).toBe(400);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid content types, oversized bodies, and unsupported methods", async () => {
    const invalidType = request("POST", {});
    invalidType.headers.set("content-type", "text/plain");
    expect((await callHandler(invalidType))?.status).toBe(400);

    const oversized = request("POST", {});
    oversized.headers.set("content-length", String(4 * 1024 + 1));
    expect((await callHandler(oversized))?.status).toBe(400);

    const method = await callHandler(request("DELETE"));
    expect(method?.status).toBe(405);
    expect(method?.headers.get("allow")).toBe("GET, POST");
  });

  it("fails closed when the signing key does not match the public key", async () => {
    const other = createKeys();
    const response = await callHandler(
      request("POST", {
        algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
        keyId: keys.keyId,
        message: Buffer.from(message).toString("base64"),
        protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
      }),
      {
        sign: (value) =>
          signWithPrivateKey("RSA-SHA256", value, other.privateKey),
      },
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: "Signing service unavailable",
    });
  });
});

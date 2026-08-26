import { generateKeyPairSync, sign as signMessage } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { transitSigning } from "./transitSigning";

const address = "https://vault.example.com";
const keyName = "bundle-signing";
const keyVersion = 7;
const publicKeyPath = "./keys/public-key.pem";
const token = "vault-token";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keyPair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const mockFetch = vi.fn<typeof fetch>();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

const publicKeyResponse = (patch: Record<string, unknown> = {}) => ({
  data: {
    keys: {
      [keyVersion]: { public_key: publicKey },
    },
    name: keyName,
    supports_signing: true,
    type: "rsa-2048",
    ...patch,
  },
});

const signatureResponse = (message: Uint8Array) => ({
  data: {
    signature: `vault:v${keyVersion}:${signMessage(
      "RSA-SHA256",
      message,
      keyPair.privateKey,
    ).toString("base64")}`,
  },
});

const createProvider = () =>
  transitSigning({
    address,
    keyName,
    keyVersion,
    mountPath: "team/transit",
    namespace: "engineering",
    publicKeyPath,
    token,
  });

describe("transitSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("pins the key version and signs the exact raw 32-byte message", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(publicKeyResponse()))
      .mockResolvedValueOnce(jsonResponse(signatureResponse(message)));
    const provider = createProvider();

    expect(provider).toMatchObject({ name: "transitSigning", publicKeyPath });
    await expect(provider.sign({ message })).resolves.toEqual({
      signature: signMessage("RSA-SHA256", message, keyPair.privateKey),
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://vault.example.com/v1/team/transit/keys/bundle-signing",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Namespace": "engineering",
          "X-Vault-Token": token,
        },
        redirect: "error",
      }),
    );
    const signCall = mockFetch.mock.calls[1];
    expect(signCall?.[0]).toBe(
      "https://vault.example.com/v1/team/transit/sign/bundle-signing/sha2-256",
    );
    expect(signCall?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          input: Buffer.from(message).toString("base64"),
          key_version: keyVersion,
          prehashed: false,
          signature_algorithm: "pkcs1v15",
        }),
        method: "POST",
        redirect: "error",
      }),
    );
  });

  it.each([
    "http://localhost:8200",
    "http://127.0.0.1:8200",
    "http://[::1]:8200",
  ])(
    "allows an insecure loopback development address: %s",
    (loopbackAddress) => {
      expect(() =>
        transitSigning({
          address: loopbackAddress,
          keyName,
          keyVersion,
          publicKeyPath,
          token,
        }),
      ).not.toThrow();
    },
  );

  it("constructs without runtime credentials and resolves them lazily", async () => {
    vi.stubEnv("VAULT_ADDR", "");
    vi.stubEnv("VAULT_TOKEN", "");
    vi.stubEnv("BAO_ADDR", "");
    vi.stubEnv("BAO_TOKEN", "");

    const provider = transitSigning({ keyName, keyVersion, publicKeyPath });

    expect(provider).toMatchObject({ name: "transitSigning", publicKeyPath });
    await expect(provider.getPublicKey()).rejects.toThrow(
      "Failed to load the Vault Transit signing public key.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("caches the validated public key", async () => {
    mockFetch.mockResolvedValue(jsonResponse(publicKeyResponse()));
    const provider = createProvider();

    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ supports_signing: false }, { type: "ecdsa-p256" }])(
    "rejects unsupported key capabilities %#",
    async (patch) => {
      mockFetch.mockResolvedValue(jsonResponse(publicKeyResponse(patch)));

      await expect(createProvider().getPublicKey()).rejects.toThrow(
        "Vault Transit key does not support RSA-SHA256 bundle signing.",
      );
    },
  );

  it.each([
    { name: "a different key", patch: { name: "other-key" } },
    { name: "a missing version", patch: { keys: {} } },
    {
      name: "a malformed public key",
      patch: { keys: { [keyVersion]: { public_key: "not pem" } } },
    },
  ])("fails closed for $name", async ({ patch }) => {
    mockFetch.mockResolvedValue(jsonResponse(publicKeyResponse(patch)));

    await expect(createProvider().getPublicKey()).rejects.toThrow(
      "Vault Transit returned an invalid signing public key response.",
    );
  });

  it.each([
    { name: "a different version", signature: "vault:v8:YWJj" },
    { name: "a malformed envelope", signature: "not-a-vault-signature" },
    { name: "an empty signature", signature: `vault:v${keyVersion}:` },
  ])("fails closed for $name", async ({ signature }) => {
    const message = new Uint8Array(32).fill(3);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(publicKeyResponse()))
      .mockResolvedValueOnce(jsonResponse({ data: { signature } }));

    await expect(createProvider().sign({ message })).rejects.toThrow(
      "Vault Transit returned an invalid signing response.",
    );
  });

  it("rejects a signature that does not match the pinned public key", async () => {
    const message = new Uint8Array(32).fill(3);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(publicKeyResponse()))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            signature: `vault:v${keyVersion}:${Buffer.alloc(256, 1).toString(
              "base64",
            )}`,
          },
        }),
      );

    await expect(createProvider().sign({ message })).rejects.toThrow(
      "unverifiable bundle signature",
    );
  });

  it("rejects invalid configuration and message sizes before requests", async () => {
    const base = { keyName, keyVersion, publicKeyPath, token };
    expect(() => transitSigning({ ...base, address: "not a URL" })).toThrow(
      "valid server address",
    );
    expect(() =>
      transitSigning({ ...base, address: "https://secret@vault.example.com" }),
    ).toThrow("valid server address");
    expect(() =>
      transitSigning({ ...base, address: "http://vault.example.com" }),
    ).toThrow("valid server address");
    expect(() => transitSigning({ ...base, address, keyVersion: 0 })).toThrow(
      "pinned key version",
    );
    expect(() => transitSigning({ ...base, address, token: " " })).toThrow(
      "token is required",
    );
    expect(() =>
      transitSigning({ ...base, address, publicKeyPath: " " }),
    ).toThrow("public key path is required");
    expect(() =>
      transitSigning({ ...base, address, mountPath: "team/../transit" }),
    ).toThrow("valid mount path");
    expect(() =>
      transitSigning({ ...base, address, keyName: "team/../bundle-signing" }),
    ).toThrow("dot path segments");

    await expect(
      createProvider().sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("signing messages must be exactly 32 bytes");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("redacts request errors and retries public-key resolution", async () => {
    mockFetch.mockRejectedValue(new Error("token=vault-secret"));
    const provider = createProvider();

    await expect(provider.getPublicKey()).rejects.toThrow(
      "Failed to load the Vault Transit signing public key.",
    );
    await expect(provider.getPublicKey()).rejects.toThrow(
      "Failed to load the Vault Transit signing public key.",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Response("{}", {
      headers: {
        "Content-Length": String(64 * 1024 + 1),
        "Content-Type": "application/json",
      },
    }),
    new Response("x".repeat(64 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    }),
  ])(
    "rejects oversized provider responses without buffering them",
    async (response) => {
      mockFetch.mockResolvedValue(response);

      await expect(createProvider().getPublicKey()).rejects.toThrow(
        "Failed to load the Vault Transit signing public key.",
      );
    },
  );

  it("redacts signing errors", async () => {
    const message = new Uint8Array(32).fill(3);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(publicKeyResponse()))
      .mockResolvedValueOnce(jsonResponse({ errors: ["token"] }, 403));
    const error = await createProvider()
      .sign({ message })
      .catch((caught) => caught);

    expect(error.message).toBe(
      "Vault Transit failed to sign the bundle message.",
    );
    expect(error.message).not.toContain(token);
  });
});

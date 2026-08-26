import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEdgeFunctionSigningHandler } from "./edgeFunctionSigningHandler";

const { createBundleSigningHandler } = vi.hoisted(() => ({
  createBundleSigningHandler: vi.fn(),
}));

vi.mock("@hot-updater/plugin-core/internal", () => ({
  createBundleSigningHandler,
}));

const toPem = (label: string, der: ArrayBuffer): string => {
  const body = Buffer.from(der)
    .toString("base64")
    .match(/.{1,64}/gu)
    ?.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

const generateKeys = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("spki", pair.publicKey),
  ]);
  return {
    pair,
    privateKeyPem: toPem("PRIVATE KEY", pkcs8),
    publicKeyPem: toPem("PUBLIC KEY", spki),
  };
};

describe("createEdgeFunctionSigningHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createBundleSigningHandler.mockImplementation(async ({ sign }) => {
      const signature = await sign(new Uint8Array(32).fill(7));
      return new Response(signature);
    });
  });

  it("imports a PKCS#8 secret as RSA-SHA256 and signs through the shared handler", async () => {
    const { pair, privateKeyPem, publicKeyPem } = await generateKeys();
    const request = new Request(
      "https://project.supabase.co/functions/v1/bundle-signer/_hot-updater/signing",
      { method: "POST" },
    );

    const response = await createEdgeFunctionSigningHandler({
      privateKey: privateKeyPem,
      publicKey: publicKeyPem,
      request,
      signingToken: "dedicated-token",
    });

    const signature = new Uint8Array(await response!.arrayBuffer());
    await expect(
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        signature,
        new Uint8Array(32).fill(7),
      ),
    ).resolves.toBe(true);
    expect(createBundleSigningHandler).toHaveBeenCalledWith({
      endpointPath: "/functions/v1/bundle-signer/_hot-updater/signing",
      publicKey: publicKeyPem,
      request,
      sign: expect.any(Function),
      token: "dedicated-token",
    });
  });

  it("accepts a non-extractable RSA signing CryptoKey", async () => {
    const { privateKeyPem, publicKeyPem } = await generateKeys();
    const pkcs8 = Buffer.from(
      privateKeyPem.replace(/-----[^-]+-----|\s/gu, ""),
      "base64",
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["sign"],
    );

    await expect(
      createEdgeFunctionSigningHandler({
        privateKey,
        publicKey: publicKeyPem,
        request: new Request(
          "https://example.com/bundle-signer/_hot-updater/signing",
        ),
        signingToken: "dedicated-token",
      }),
    ).resolves.toBeInstanceOf(Response);
  });

  it("rejects extractable keys and malformed PEM without exposing key material", async () => {
    const { pair, publicKeyPem } = await generateKeys();
    const request = new Request("https://example.com/_hot-updater/signing");

    await expect(
      createEdgeFunctionSigningHandler({
        privateKey: pair.privateKey,
        publicKey: publicKeyPem,
        request,
        signingToken: "dedicated-token",
      }),
    ).rejects.toThrow("Supabase bundle signing private key is invalid.");
    await expect(
      createEdgeFunctionSigningHandler({
        privateKey: "not-a-private-key",
        publicKey: publicKeyPem,
        request,
        signingToken: "dedicated-token",
      }),
    ).rejects.toThrow("Supabase bundle signing private key is invalid.");
  });

  it("ignores unrelated Edge Function routes before reading private key material", async () => {
    await expect(
      createEdgeFunctionSigningHandler({
        privateKey: "not-a-private-key",
        publicKey: "not-a-public-key",
        request: new Request("https://example.com/updates"),
        signingToken: "dedicated-token",
      }),
    ).resolves.toBeNull();
    expect(createBundleSigningHandler).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBundleSigningHandler: vi.fn(),
}));

vi.mock("@hot-updater/plugin-core/internal", () => ({
  createBundleSigningHandler: mocks.createBundleSigningHandler,
}));

import { createWorkerSigningHandler } from "./workerSigningHandler";

const request = new Request(
  "https://hot-updater.example.workers.dev/_hot-updater/signing",
);

const privateKey = (patch: Partial<CryptoKey> = {}) =>
  ({
    algorithm: {
      hash: { name: "SHA-256" },
      name: "RSASSA-PKCS1-v1_5",
    },
    extractable: false,
    type: "private",
    usages: ["sign"],
    ...patch,
  }) as CryptoKey;

describe("createWorkerSigningHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBundleSigningHandler.mockResolvedValue(new Response("handled"));
  });

  it("delegates the fixed signing route to the shared handler", async () => {
    const result = await createWorkerSigningHandler({
      privateKey: privateKey(),
      publicKey: "public-key",
      request,
      signingToken: "signing-token",
    });

    expect(await result?.text()).toBe("handled");
    expect(mocks.createBundleSigningHandler).toHaveBeenCalledWith({
      endpointPath: "/_hot-updater/signing",
      publicKey: "public-key",
      request,
      sign: expect.any(Function),
      token: "signing-token",
    });
  });

  it("handles the full signing pathname for a prefixed Worker route", async () => {
    const prefixedRequest = new Request(
      "https://hot-updater.example.workers.dev/custom/_hot-updater/signing",
    );

    const result = await createWorkerSigningHandler({
      endpointPath: "/custom/_hot-updater/signing",
      privateKey: privateKey(),
      publicKey: "public-key",
      request: prefixedRequest,
      signingToken: "signing-token",
    });

    expect(await result?.text()).toBe("handled");
    expect(mocks.createBundleSigningHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointPath: "/custom/_hot-updater/signing",
        request: prefixedRequest,
      }),
    );
  });

  it("signs the exact message with the bound RSA CryptoKey", async () => {
    const key = privateKey();
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = new Uint8Array([1, 2, 3]);
    const sign = vi
      .spyOn(crypto.subtle, "sign")
      .mockResolvedValue(signature.buffer);
    await createWorkerSigningHandler({
      privateKey: key,
      publicKey: "public-key",
      request,
      signingToken: "signing-token",
    });
    const handlerOptions = mocks.createBundleSigningHandler.mock.calls[0]![0];

    await expect(handlerOptions.sign(message)).resolves.toEqual(signature);
    expect(sign).toHaveBeenCalledWith("RSASSA-PKCS1-v1_5", key, message);
  });

  it("ignores unrelated OTA requests before reading signing key capabilities", async () => {
    mocks.createBundleSigningHandler.mockResolvedValueOnce(null);
    const result = await createWorkerSigningHandler({
      privateKey: privateKey({ extractable: true }),
      publicKey: "public-key",
      request: new Request(
        "https://hot-updater.example.workers.dev/api/check-update",
      ),
      signingToken: "signing-token",
    });

    expect(result).toBeNull();
    expect(mocks.createBundleSigningHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "https://hot-updater.example.workers.dev/api/check-update",
        }),
      }),
    );
  });

  it.each([
    { name: "a public key", patch: { type: "public" } },
    { name: "an extractable key", patch: { extractable: true } },
    {
      name: "a different algorithm",
      patch: { algorithm: { hash: { name: "SHA-256" }, name: "RSA-PSS" } },
    },
    {
      name: "a different hash",
      patch: {
        algorithm: {
          hash: { name: "SHA-384" },
          name: "RSASSA-PKCS1-v1_5",
        },
      },
    },
    { name: "additional key usage", patch: { usages: ["sign", "decrypt"] } },
  ])("rejects $name before signing", async ({ patch }) => {
    await createWorkerSigningHandler({
      privateKey: privateKey(patch as Partial<CryptoKey>),
      publicKey: "public-key",
      request,
      signingToken: "signing-token",
    });
    const handlerOptions = mocks.createBundleSigningHandler.mock.calls[0]![0];

    await expect(handlerOptions.sign(new Uint8Array(32))).rejects.toThrow(
      "Cloudflare Worker signing requires a non-extractable, sign-only RSA-SHA256 private CryptoKey binding.",
    );
  });
});

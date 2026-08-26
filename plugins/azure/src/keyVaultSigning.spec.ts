import { generateKeyPairSync, sign as signMessage } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credential: {},
  getKey: vi.fn(),
  signData: vi.fn(),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function () {
    return mocks.credential;
  }),
}));

vi.mock("@azure/keyvault-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/keyvault-keys")>();
  return {
    ...actual,
    CryptographyClient: vi.fn(function () {
      return { signData: mocks.signData };
    }),
    KeyClient: vi.fn(function () {
      return { getKey: mocks.getKey };
    }),
  };
});

import { CryptographyClient, KeyClient } from "@azure/keyvault-keys";

import { keyVaultSigning } from "./keyVaultSigning";

const keyId =
  "https://hot-updater.vault.azure.net/keys/bundle-signing/00000000000000000000000000000001";
const publicKeyPath = "./keys/public-key.pem";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });
const modulus = new Uint8Array(Buffer.from(publicJwk.n!, "base64url"));
const exponent = new Uint8Array(Buffer.from(publicJwk.e!, "base64url"));

const publicKeyResponse = () => ({
  id: keyId,
  key: { e: exponent, n: modulus },
  keyOperations: ["sign", "verify"],
  keyType: "RSA-HSM",
  name: "bundle-signing",
  properties: {
    enabled: true,
    name: "bundle-signing",
    vaultUrl: "https://hot-updater.vault.azure.net",
    version: "00000000000000000000000000000001",
  },
});

const mockPublicKey = () => {
  mocks.getKey.mockResolvedValue(publicKeyResponse());
};

const signatureResponse = (message: Uint8Array) => {
  const result = signMessage("RSA-SHA256", message, keyPair.privateKey);
  return {
    algorithm: "RS256",
    keyID: keyId,
    result,
  } as const;
};

const mockSignature = (message: Uint8Array) => {
  const response = signatureResponse(message);
  mocks.signData.mockResolvedValue(response);
  const { result } = response;
  return result;
};

const createProvider = () => keyVaultSigning({ keyId, publicKeyPath });

describe("keyVaultSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublicKey();
  });

  it("pins the key version and signs the exact raw 32-byte message", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = mockSignature(message);
    const provider = createProvider();

    expect(provider).toMatchObject({ name: "keyVaultSigning", publicKeyPath });
    await expect(provider.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(signature),
    });
    expect(KeyClient).toHaveBeenCalledWith(
      "https://hot-updater.vault.azure.net",
      mocks.credential,
    );
    expect(CryptographyClient).toHaveBeenCalledWith(keyId, mocks.credential);
    expect(mocks.getKey).toHaveBeenCalledWith("bundle-signing", {
      version: "00000000000000000000000000000001",
    });
    expect(mocks.signData).toHaveBeenCalledWith("RS256", message);
    expect(mocks.signData.mock.calls[0]?.[1]).toBe(message);
  });

  it("caches the validated public key across identity and signing calls", async () => {
    const message = new Uint8Array(32).fill(7);
    mockSignature(message);
    const provider = createProvider();

    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();
    await provider.sign({ message });

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(mocks.getKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    { keyType: "EC", keyOperations: ["sign"] },
    { keyType: "RSA", keyOperations: ["encrypt"] },
  ])("rejects unsupported key capabilities %#", async (patch) => {
    mocks.getKey.mockResolvedValueOnce({
      ...publicKeyResponse(),
      ...patch,
    });

    await expect(createProvider().getPublicKey()).rejects.toThrow(
      "Azure Key Vault key does not support RSA-SHA256 bundle signing.",
    );
    expect(mocks.signData).not.toHaveBeenCalled();
  });

  it("rejects unpinned keys, empty public paths, and invalid message sizes", async () => {
    expect(() =>
      keyVaultSigning({
        keyId: "https://hot-updater.vault.azure.net/keys/bundle-signing",
        publicKeyPath,
      }),
    ).toThrow("version-pinned HTTPS key identifier");
    expect(() =>
      keyVaultSigning({
        keyId: keyId.replace("https://", "https://secret@"),
        publicKeyPath,
      }),
    ).toThrow("version-pinned HTTPS key identifier");
    expect(() => keyVaultSigning({ keyId, publicKeyPath: " " })).toThrow(
      "public key path is required",
    );

    await expect(
      createProvider().sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("signing messages must be exactly 32 bytes");
    expect(mocks.getKey).not.toHaveBeenCalled();
    expect(mocks.signData).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a different key ID", patch: { id: `${keyId}0` } },
    { name: "a disabled key", patch: { properties: { enabled: false } } },
    { name: "missing RSA parameters", patch: { key: {} } },
  ])("fails closed for $name", async ({ patch }) => {
    const response = publicKeyResponse();
    mocks.getKey.mockResolvedValueOnce({
      ...response,
      ...patch,
      properties: {
        ...response.properties,
        ...patch.properties,
      },
    });

    await expect(createProvider().getPublicKey()).rejects.toThrow(
      "Azure Key Vault returned an invalid signing public key response.",
    );
  });

  it.each([
    { name: "a different key ID", patch: { keyID: `${keyId}0` } },
    { name: "a different algorithm", patch: { algorithm: "PS256" } },
    { name: "an empty signature", patch: { result: new Uint8Array() } },
  ])("fails closed for $name in a signing response", async ({ patch }) => {
    const message = new Uint8Array(32).fill(3);
    mocks.signData.mockResolvedValueOnce({
      ...signatureResponse(message),
      ...patch,
    });

    await expect(createProvider().sign({ message })).rejects.toThrow(
      "Azure Key Vault returned an invalid signing response.",
    );
  });

  it("rejects a signature that does not match the pinned public key", async () => {
    mocks.signData.mockResolvedValue({
      algorithm: "RS256",
      keyID: keyId,
      result: new Uint8Array(256).fill(1),
    });

    await expect(
      createProvider().sign({ message: new Uint8Array(32) }),
    ).rejects.toThrow("unverifiable bundle signature");
  });

  it("redacts provider errors and retries public-key resolution", async () => {
    mocks.getKey.mockRejectedValue(new Error("access token=super-secret"));
    const provider = createProvider();

    await expect(provider.getPublicKey()).rejects.toThrow(
      "Failed to load the Azure Key Vault signing public key.",
    );
    await expect(provider.getPublicKey()).rejects.toThrow(
      "Failed to load the Azure Key Vault signing public key.",
    );
    expect(mocks.getKey).toHaveBeenCalledTimes(2);
  });

  it("redacts signing errors", async () => {
    mocks.signData.mockRejectedValue(new Error("access token=super-secret"));
    const error = await createProvider()
      .sign({ message: new Uint8Array(32) })
      .catch((caught) => caught);

    expect(error.message).toBe(
      "Azure Key Vault failed to sign the bundle message.",
    );
    expect(error.message).not.toContain("super-secret");
  });
});

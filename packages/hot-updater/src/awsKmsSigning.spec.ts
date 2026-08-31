import { generateKeyPairSync, sign as signMessage } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-kms", () => {
  class GetPublicKeyCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class SignCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    GetPublicKeyCommand,
    KMSClient: mocks.clientConstructor.mockImplementation(function () {
      return { send: mocks.send };
    }),
    SignCommand,
  };
});

import { awsKmsSigning } from "./awsKmsSigning";

const canonicalKeyId =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyDer = keyPair.publicKey.export({
  format: "der",
  type: "spki",
});

const publicKeyResponse = () => ({
  KeyId: canonicalKeyId,
  KeySpec: "RSA_2048",
  KeyUsage: "SIGN_VERIFY",
  PublicKey: publicKeyDer,
  SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256"],
});

describe("awsKmsSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockResolvedValue(publicKeyResponse());
  });

  it("loads the optional SDK lazily and pins the canonical key ID", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
    mocks.send
      .mockResolvedValueOnce(publicKeyResponse())
      .mockResolvedValueOnce({
        KeyId: canonicalKeyId,
        Signature: signature,
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      });

    const provider = awsKmsSigning({
      keyId: "alias/hot-updater-bundle-signing",
      region: "us-east-1",
    });

    expect(provider).toMatchObject({ name: "awsKmsSigning" });
    expect(mocks.clientConstructor).not.toHaveBeenCalled();

    await expect(provider.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(signature),
    });

    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      endpoint: undefined,
      ignoreConfiguredEndpointUrls: true,
      region: "us-east-1",
    });
    expect(mocks.send.mock.calls[0]?.[0].input).toEqual({
      KeyId: "alias/hot-updater-bundle-signing",
    });
    expect(mocks.send.mock.calls[1]?.[0].input).toEqual({
      KeyId: canonicalKeyId,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
  });

  it("caches the validated public key", async () => {
    const provider = awsKmsSigning({
      keyId: canonicalKeyId,
      region: "us-east-1",
    });

    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported keys before attempting to sign", async () => {
    mocks.send.mockResolvedValue({
      ...publicKeyResponse(),
      KeySpec: "ECC_NIST_P256",
      SigningAlgorithms: ["ECDSA_SHA_256"],
    });
    const provider = awsKmsSigning({
      keyId: canonicalKeyId,
      region: "us-east-1",
    });

    await expect(
      provider.sign({ message: new Uint8Array(32) }),
    ).rejects.toThrow(
      "AWS KMS key does not support RSA-SHA256 bundle signing.",
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and unverifiable signing responses", async () => {
    mocks.send
      .mockResolvedValueOnce(publicKeyResponse())
      .mockResolvedValueOnce({
        KeyId: canonicalKeyId,
        Signature: new Uint8Array([1, 2, 3]),
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      });
    const provider = awsKmsSigning({
      keyId: canonicalKeyId,
      region: "us-east-1",
    });

    await expect(
      provider.sign({ message: new Uint8Array(32).fill(3) }),
    ).rejects.toThrow("AWS KMS returned an unverifiable bundle signature.");
  });

  it("rejects invalid configuration and unsafe custom endpoints", () => {
    expect(() =>
      awsKmsSigning({
        keyId: canonicalKeyId,
        region: " ",
      }),
    ).toThrow("region is required");
    expect(() =>
      awsKmsSigning({
        endpoint: "http://kms.example.com",
        keyId: canonicalKeyId,
        region: "us-east-1",
      }),
    ).toThrow("must use HTTPS or an HTTP loopback URL");
    expect(() =>
      awsKmsSigning({
        endpoint: "http://127.0.0.1:4566",
        keyId: canonicalKeyId,
        region: "us-east-1",
      }),
    ).not.toThrow();
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it("rejects messages outside the signing contract without loading the SDK", async () => {
    const provider = awsKmsSigning({
      keyId: canonicalKeyId,
      region: "us-east-1",
    });

    await expect(
      provider.sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("messages must be exactly 32 bytes");
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });
});

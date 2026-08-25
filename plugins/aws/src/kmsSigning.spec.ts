import { generateKeyPairSync, sign as signMessage } from "node:crypto";

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { kmsSigning } from "./kmsSigning";

const kms = mockClient(KMSClient);
const canonicalKeyId =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const publicKeyPath = "./keys/public-key.pem";

const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicKeyDer = keyPair.publicKey.export({
  format: "der",
  type: "spki",
});

const mockPublicKey = () => {
  kms.on(GetPublicKeyCommand).resolves({
    KeyId: canonicalKeyId,
    KeySpec: "RSA_2048",
    KeyUsage: "SIGN_VERIFY",
    PublicKey: publicKeyDer,
    SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256"],
  });
};

describe("kmsSigning", () => {
  beforeEach(() => {
    kms.reset();
    mockPublicKey();
  });

  it("pins the canonical key ID and signs the exact 32-byte message", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
    kms.on(SignCommand).resolves({
      KeyId: canonicalKeyId,
      Signature: signature,
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    const provider = kmsSigning({
      keyId: "alias/hot-updater-bundle-signing",
      publicKeyPath,
      region: "us-east-1",
    });

    expect(provider).toMatchObject({ name: "kmsSigning", publicKeyPath });

    await expect(provider.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(signature),
    });

    expect(kms.commandCalls(GetPublicKeyCommand)).toHaveLength(1);
    expect(kms.commandCalls(GetPublicKeyCommand)[0]?.args[0].input).toEqual({
      KeyId: "alias/hot-updater-bundle-signing",
    });
    const signInput = kms.commandCalls(SignCommand)[0]?.args[0].input;
    expect(signInput).toEqual({
      KeyId: canonicalKeyId,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    expect(signInput?.Message).toBe(message);
  });

  it("caches the canonical public key across identity and signing calls", async () => {
    const message = new Uint8Array(32).fill(7);
    const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
    kms.on(SignCommand).resolves({
      KeyId: canonicalKeyId,
      Signature: signature,
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    const provider = kmsSigning({
      keyId: canonicalKeyId,
      publicKeyPath,
      region: "us-east-1",
    });

    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();
    await provider.sign({ message });

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(kms.commandCalls(GetPublicKeyCommand)).toHaveLength(1);
  });

  it("rejects unsupported keys before attempting to sign", async () => {
    kms.on(GetPublicKeyCommand).resolves({
      KeyId: canonicalKeyId,
      KeySpec: "ECC_NIST_P256",
      KeyUsage: "SIGN_VERIFY",
      PublicKey: publicKeyDer,
      SigningAlgorithms: ["ECDSA_SHA_256"],
    });
    const provider = kmsSigning({
      keyId: canonicalKeyId,
      publicKeyPath,
      region: "us-east-1",
    });

    await expect(
      provider.sign({ message: new Uint8Array(32) }),
    ).rejects.toThrow(
      "AWS KMS key does not support RSA-SHA256 bundle signing.",
    );
    expect(kms.commandCalls(SignCommand)).toHaveLength(0);
  });

  it("fails closed when KMS omits the canonical key identity", async () => {
    kms.on(GetPublicKeyCommand).resolves({
      KeySpec: "RSA_2048",
      KeyUsage: "SIGN_VERIFY",
      PublicKey: publicKeyDer,
      SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256"],
    });
    const provider = kmsSigning({
      keyId: "alias/hot-updater-bundle-signing",
      publicKeyPath,
      region: "us-east-1",
    });

    await expect(provider.getPublicKey()).rejects.toThrow(
      "AWS KMS returned an invalid signing public key response.",
    );
    expect(kms.commandCalls(SignCommand)).toHaveLength(0);
  });

  it("rejects malformed or unverifiable signing responses", async () => {
    const message = new Uint8Array(32).fill(3);
    kms.on(SignCommand).resolves({
      KeyId: canonicalKeyId,
      Signature: new Uint8Array([1, 2, 3]),
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    const provider = kmsSigning({
      keyId: canonicalKeyId,
      publicKeyPath,
      region: "us-east-1",
    });

    await expect(provider.sign({ message })).rejects.toThrow(
      "AWS KMS returned an unverifiable bundle signature.",
    );
  });

  it("rejects messages that are not SHA-256-sized", async () => {
    const provider = kmsSigning({
      keyId: canonicalKeyId,
      publicKeyPath,
      region: "us-east-1",
    });

    await expect(
      provider.sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("AWS KMS signing messages must be exactly 32 bytes.");
    expect(kms.calls()).toHaveLength(0);
  });

  it("rejects an empty public key path before creating a signing session", () => {
    expect(() =>
      kmsSigning({
        keyId: canonicalKeyId,
        publicKeyPath: " ",
        region: "us-east-1",
      }),
    ).toThrow("AWS KMS signing public key path is required.");
    expect(kms.calls()).toHaveLength(0);
  });
});

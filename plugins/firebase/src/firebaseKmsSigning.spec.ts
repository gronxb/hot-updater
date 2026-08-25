import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";

import { protos } from "@google-cloud/kms";
import crc32c from "fast-crc32c";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  asymmetricSign: vi.fn(),
  getPublicKey: vi.fn(),
}));

vi.mock("@google-cloud/kms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google-cloud/kms")>();
  return {
    ...actual,
    KeyManagementServiceClient: vi.fn(function () {
      return mocks;
    }),
  };
});

import { firebaseKmsSigning } from "./firebaseKmsSigning";

const keyVersion =
  "projects/firebase-project/locations/global/keyRings/hot-updater/cryptoKeys/bundle-signing/cryptoKeyVersions/1";
const publicKeyPath = "./keys/public-key.pem";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keyPair.publicKey
  .export({
    format: "pem",
    type: "spki",
  })
  .toString();
const Algorithms =
  protos.google.cloud.kms.v1.CryptoKeyVersion.CryptoKeyVersionAlgorithm;

const mockPublicKey = () => {
  mocks.getPublicKey.mockResolvedValue([
    {
      algorithm: Algorithms.RSA_SIGN_PKCS1_2048_SHA256,
      name: keyVersion,
      pem: publicKey,
      pemCrc32c: { value: crc32c.calculate(publicKey) },
    },
  ]);
};

const mockSignature = (message: Uint8Array) => {
  const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
  mocks.asymmetricSign.mockResolvedValue([
    {
      name: keyVersion,
      signature,
      signatureCrc32c: { value: crc32c.calculate(Buffer.from(signature)) },
      verifiedDigestCrc32c: true,
    },
  ]);
  return signature;
};

const createProvider = () => firebaseKmsSigning({ keyVersion, publicKeyPath });

describe("firebaseKmsSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublicKey();
  });

  it("pins the key version and signs the SHA-256 digest of the raw message", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = mockSignature(message);
    const provider = createProvider();

    await expect(provider.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(signature),
    });

    expect(mocks.getPublicKey).toHaveBeenCalledWith({ name: keyVersion });
    const expectedDigest = createHash("sha256").update(message).digest();
    expect(mocks.asymmetricSign).toHaveBeenCalledWith({
      name: keyVersion,
      digest: { sha256: expectedDigest },
      digestCrc32c: { value: crc32c.calculate(expectedDigest) },
    });
  });

  it("exposes its public key path and caches the validated public key", async () => {
    const message = new Uint8Array(32).fill(7);
    mockSignature(message);
    const provider = createProvider();

    expect(provider.publicKeyPath).toBe(publicKeyPath);
    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();
    await provider.sign({ message });

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(mocks.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    Algorithms.RSA_SIGN_PSS_2048_SHA256,
    Algorithms.EC_SIGN_P256_SHA256,
  ])("rejects unsupported signing algorithm %s", async (algorithm) => {
    mocks.getPublicKey.mockResolvedValue([
      {
        algorithm,
        name: keyVersion,
        pem: publicKey,
        pemCrc32c: { value: crc32c.calculate(publicKey) },
      },
    ]);
    const provider = createProvider();

    await expect(provider.getPublicKey()).rejects.toThrow(
      "Firebase Google Cloud KMS key does not support RSA-SHA256 bundle signing.",
    );
    expect(mocks.asymmetricSign).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a different key name", patch: { name: `${keyVersion}0` } },
    { name: "a bad PEM checksum", patch: { pemCrc32c: { value: 1 } } },
    { name: "a malformed public key", patch: { pem: "not a public key" } },
  ])("fails closed for $name", async ({ patch }) => {
    const pem = typeof patch.pem === "string" ? patch.pem : publicKey;
    mocks.getPublicKey.mockResolvedValue([
      {
        algorithm: Algorithms.RSA_SIGN_PKCS1_2048_SHA256,
        name: keyVersion,
        pem,
        pemCrc32c: { value: crc32c.calculate(pem) },
        ...patch,
      },
    ]);

    await expect(createProvider().getPublicKey()).rejects.toThrow(
      "Firebase Google Cloud KMS returned an invalid signing public key response.",
    );
  });

  it.each([
    {
      name: "a different key version",
      patch: { name: `${keyVersion}0` },
    },
    { name: "an unverified digest", patch: { verifiedDigestCrc32c: false } },
    {
      name: "a bad signature checksum",
      patch: { signatureCrc32c: { value: 1 } },
    },
  ])("fails closed for $name in a signing response", async ({ patch }) => {
    const message = new Uint8Array(32).fill(3);
    const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
    mocks.asymmetricSign.mockResolvedValue([
      {
        name: keyVersion,
        signature,
        signatureCrc32c: {
          value: crc32c.calculate(Buffer.from(signature)),
        },
        verifiedDigestCrc32c: true,
        ...patch,
      },
    ]);

    await expect(createProvider().sign({ message })).rejects.toThrow(
      "Firebase Google Cloud KMS returned an invalid signing response.",
    );
  });

  it("rejects a checksum-valid signature that does not match the public key", async () => {
    const message = new Uint8Array(32).fill(3);
    const signature = new Uint8Array(256).fill(1);
    mocks.asymmetricSign.mockResolvedValue([
      {
        name: keyVersion,
        signature,
        signatureCrc32c: {
          value: crc32c.calculate(Buffer.from(signature)),
        },
        verifiedDigestCrc32c: true,
      },
    ]);

    await expect(createProvider().sign({ message })).rejects.toThrow(
      "Firebase Google Cloud KMS returned an unverifiable bundle signature.",
    );
  });

  it("rejects unpinned resources, empty public paths, and non-SHA256-sized messages", async () => {
    expect(() =>
      firebaseKmsSigning({
        keyVersion: "projects/p/locations/global/keyRings/r/cryptoKeys/k",
        publicKeyPath,
      }),
    ).toThrow("version-pinned key resource name");
    expect(() =>
      firebaseKmsSigning({ keyVersion, publicKeyPath: " " }),
    ).toThrow("public key path is required");

    await expect(
      createProvider().sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("signing messages must be exactly 32 bytes");
    expect(mocks.getPublicKey).not.toHaveBeenCalled();
    expect(mocks.asymmetricSign).not.toHaveBeenCalled();
  });

  it("redacts Cloud KMS errors and retries public-key resolution", async () => {
    mocks.getPublicKey
      .mockRejectedValueOnce(new Error("credential=super-secret"))
      .mockRejectedValueOnce(new Error("credential=super-secret"));
    const provider = createProvider();

    const firstError = await provider.getPublicKey().catch((error) => error);
    const secondError = await provider.getPublicKey().catch((error) => error);

    expect(firstError.message).toBe(
      "Failed to load the Firebase Google Cloud KMS signing public key.",
    );
    expect(firstError.message).not.toContain("super-secret");
    expect(secondError.message).toBe(firstError.message);
    expect(mocks.getPublicKey).toHaveBeenCalledTimes(2);
  });

  it("redacts Cloud KMS signing errors", async () => {
    mocks.asymmetricSign.mockRejectedValue(
      new Error("access token: super-secret"),
    );
    const error = await createProvider()
      .sign({ message: new Uint8Array(32) })
      .catch((caught) => caught);

    expect(error.message).toBe(
      "Firebase Google Cloud KMS failed to sign the bundle message.",
    );
    expect(error.message).not.toContain("super-secret");
  });
});

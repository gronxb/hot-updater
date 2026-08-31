import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  asymmetricSign: vi.fn(),
  clientConstructor: vi.fn(),
  getPublicKey: vi.fn(),
}));

vi.mock("@google-cloud/kms", () => ({
  KeyManagementServiceClient: mocks.clientConstructor.mockImplementation(
    function () {
      return {
        asymmetricSign: mocks.asymmetricSign,
        getPublicKey: mocks.getPublicKey,
      };
    },
  ),
}));

import { googleCloudKmsSigning } from "./googleCloudKmsSigning";

const keyVersion =
  "projects/google-cloud-project/locations/global/keyRings/hot-updater/cryptoKeys/bundle-signing/cryptoKeyVersions/1";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keyPair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

const crc32c = (value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const publicKeyResponse = () => ({
  algorithm: "RSA_SIGN_PKCS1_2048_SHA256",
  name: keyVersion,
  pem: publicKey,
  pemCrc32c: { value: crc32c(publicKey) },
});

describe("googleCloudKmsSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicKey.mockResolvedValue([publicKeyResponse()]);
  });

  it("loads the optional SDK lazily and signs the message digest", async () => {
    const message = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = signMessage("RSA-SHA256", message, keyPair.privateKey);
    mocks.asymmetricSign.mockResolvedValue([
      {
        name: keyVersion,
        signature,
        signatureCrc32c: { value: crc32c(signature) },
        verifiedDigestCrc32c: true,
      },
    ]);
    const provider = googleCloudKmsSigning({ keyVersion });

    expect(provider).toMatchObject({
      name: "googleCloudKmsSigning",
    });
    expect(mocks.clientConstructor).not.toHaveBeenCalled();

    await expect(provider.sign({ message })).resolves.toEqual({
      signature: new Uint8Array(signature),
    });

    const digest = createHash("sha256").update(message).digest();
    expect(mocks.asymmetricSign).toHaveBeenCalledWith({
      name: keyVersion,
      digest: { sha256: digest },
      digestCrc32c: { value: crc32c(digest) },
    });
  });

  it("caches the validated public key", async () => {
    const provider = googleCloudKmsSigning({ keyVersion });

    const first = await provider.getPublicKey();
    const second = await provider.getPublicKey();

    expect(first).toEqual(second);
    expect(first.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    expect(mocks.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it.each([8, "RSA_SIGN_PSS_2048_SHA256", "EC_SIGN_P256_SHA256"])(
    "rejects unsupported signing algorithm %s",
    async (algorithm) => {
      mocks.getPublicKey.mockResolvedValue([
        { ...publicKeyResponse(), algorithm },
      ]);

      await expect(
        googleCloudKmsSigning({ keyVersion }).getPublicKey(),
      ).rejects.toThrow(
        "Google Cloud KMS key does not support RSA-SHA256 bundle signing.",
      );
      expect(mocks.asymmetricSign).not.toHaveBeenCalled();
    },
  );

  it("accepts the numeric RSA_SIGN_PKCS1_2048_SHA256 enum value", async () => {
    mocks.getPublicKey.mockResolvedValue([
      { ...publicKeyResponse(), algorithm: 5 },
    ]);

    await expect(
      googleCloudKmsSigning({ keyVersion }).getPublicKey(),
    ).resolves.toMatchObject({ publicKey: expect.any(String) });
  });

  it.each([
    { name: "a different key name", patch: { name: `${keyVersion}0` } },
    { name: "a bad PEM checksum", patch: { pemCrc32c: { value: 1 } } },
    { name: "a malformed public key", patch: { pem: "not a public key" } },
  ])("fails closed for $name", async ({ patch }) => {
    const pem = typeof patch.pem === "string" ? patch.pem : publicKey;
    mocks.getPublicKey.mockResolvedValue([
      {
        ...publicKeyResponse(),
        pem,
        pemCrc32c: { value: crc32c(pem) },
        ...patch,
      },
    ]);

    await expect(
      googleCloudKmsSigning({ keyVersion }).getPublicKey(),
    ).rejects.toThrow(
      "Google Cloud KMS returned an invalid signing public key response.",
    );
  });

  it("rejects invalid and unverifiable signing responses", async () => {
    const message = new Uint8Array(32).fill(3);
    const signature = new Uint8Array(256).fill(1);
    mocks.asymmetricSign.mockResolvedValue([
      {
        name: keyVersion,
        signature,
        signatureCrc32c: { value: crc32c(signature) },
        verifiedDigestCrc32c: true,
      },
    ]);

    await expect(
      googleCloudKmsSigning({ keyVersion }).sign({ message }),
    ).rejects.toThrow(
      "Google Cloud KMS returned an unverifiable bundle signature.",
    );
  });

  it("rejects invalid configuration and message sizes before loading the SDK", async () => {
    expect(() =>
      googleCloudKmsSigning({
        keyVersion: "projects/p/locations/global/keyRings/r/cryptoKeys/k",
      }),
    ).toThrow("version-pinned key resource name");

    const provider = googleCloudKmsSigning({ keyVersion });
    await expect(
      provider.sign({ message: new Uint8Array(31) }),
    ).rejects.toThrow("messages must be exactly 32 bytes");
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it("redacts provider errors and retries public-key resolution", async () => {
    mocks.getPublicKey.mockRejectedValue(new Error("token=super-secret"));
    const provider = googleCloudKmsSigning({ keyVersion });

    const first = await provider.getPublicKey().catch((error) => error);
    const second = await provider.getPublicKey().catch((error) => error);

    expect(first.message).toBe(
      "Failed to load the Google Cloud KMS signing public key.",
    );
    expect(first.message).not.toContain("super-secret");
    expect(second.message).toBe(first.message);
    expect(mocks.getPublicKey).toHaveBeenCalledTimes(2);
  });
});

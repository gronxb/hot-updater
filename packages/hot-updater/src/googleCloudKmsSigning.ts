import { createHash, createPublicKey, verify } from "node:crypto";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

const KEY_VERSION_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/u;

const SUPPORTED_ALGORITHMS = new Set<unknown>([
  5,
  6,
  7,
  "RSA_SIGN_PKCS1_2048_SHA256",
  "RSA_SIGN_PKCS1_3072_SHA256",
  "RSA_SIGN_PKCS1_4096_SHA256",
]);

export interface GoogleCloudKmsSigningOptions {
  /** Version-pinned Google Cloud KMS asymmetric signing key resource name. */
  readonly keyVersion: string;
}

interface GoogleCloudKmsClient {
  asymmetricSign(request: unknown): Promise<readonly [unknown]>;
  getPublicKey(request: unknown): Promise<readonly [unknown]>;
}

interface GoogleCloudKmsSdk {
  KeyManagementServiceClient: new () => GoogleCloudKmsClient;
}

interface GooglePublicKeyResponse {
  algorithm?: unknown;
  name?: unknown;
  pem?: unknown;
  pemCrc32c?: unknown;
}

interface GoogleSignResponse {
  name?: unknown;
  signature?: unknown;
  signatureCrc32c?: unknown;
  verifiedDigestCrc32c?: unknown;
}

interface ResolvedGoogleCloudKmsKey {
  publicKey: string;
}

const toBytes = (value: Uint8Array | string) =>
  typeof value === "string" ? Buffer.from(value, "utf8") : value;

const crc32c = (value: Uint8Array | string) => {
  let crc = 0xffffffff;
  for (const byte of toBytes(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const unwrapChecksum = (checksum: unknown) => {
  if (
    typeof checksum === "object" &&
    checksum !== null &&
    "value" in checksum
  ) {
    return checksum.value;
  }
  return checksum;
};

const checksumMatches = (value: Uint8Array | string, checksum: unknown) => {
  const numericChecksum = Number(unwrapChecksum(checksum));
  return (
    Number.isInteger(numericChecksum) &&
    numericChecksum >= 0 &&
    numericChecksum <= 0xffffffff &&
    crc32c(value) === numericChecksum
  );
};

const invalidPublicKeyResponse = () =>
  new Error(
    "Google Cloud KMS returned an invalid signing public key response.",
  );

const unsupportedSigningKey = () =>
  new Error("Google Cloud KMS key does not support RSA-SHA256 bundle signing.");

const loadGoogleCloudKmsSdk = async (): Promise<GoogleCloudKmsSdk> => {
  try {
    return (await import("@google-cloud/kms")) as unknown as GoogleCloudKmsSdk;
  } catch {
    throw new Error(
      "googleCloudKmsSigning requires the optional @google-cloud/kms package.",
    );
  }
};

const loadPublicKey = async (
  client: GoogleCloudKmsClient,
  keyVersion: string,
): Promise<ResolvedGoogleCloudKmsKey> => {
  let response: GooglePublicKeyResponse;
  try {
    [response] = (await client.getPublicKey({
      name: keyVersion,
    })) as readonly [GooglePublicKeyResponse];
  } catch {
    throw new Error("Failed to load the Google Cloud KMS signing public key.");
  }

  if (
    response.name !== keyVersion ||
    typeof response.pem !== "string" ||
    !response.pem ||
    !checksumMatches(response.pem, response.pemCrc32c)
  ) {
    throw invalidPublicKeyResponse();
  }
  if (!SUPPORTED_ALGORITHMS.has(response.algorithm)) {
    throw unsupportedSigningKey();
  }

  try {
    const normalizedPublicKey = response.pem.trim();
    if (
      !normalizedPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
      !normalizedPublicKey.endsWith("-----END PUBLIC KEY-----")
    ) {
      throw new Error("not spki");
    }
    const publicKey = createPublicKey(normalizedPublicKey);
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("unsupported key");
    }
    return {
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
  } catch {
    throw invalidPublicKeyResponse();
  }
};

/** Creates a bundle signer backed by a version-pinned Google Cloud KMS key. */
export const googleCloudKmsSigning = ({
  keyVersion,
}: GoogleCloudKmsSigningOptions): BundleSigningPlugin => {
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error(
      "Google Cloud KMS signing requires a version-pinned key resource name.",
    );
  }
  let clientPromise: Promise<GoogleCloudKmsClient> | undefined;
  const resolveClient = () => {
    if (clientPromise) return clientPromise;
    clientPromise = loadGoogleCloudKmsSdk()
      .then((sdk) => new sdk.KeyManagementServiceClient())
      .catch((error) => {
        clientPromise = undefined;
        throw error;
      });
    return clientPromise;
  };

  let resolvedKeyPromise: Promise<ResolvedGoogleCloudKmsKey> | undefined;
  const resolveKey = () => {
    if (resolvedKeyPromise) return resolvedKeyPromise;
    resolvedKeyPromise = resolveClient()
      .then((client) => loadPublicKey(client, keyVersion))
      .catch((error) => {
        resolvedKeyPromise = undefined;
        throw error;
      });
    return resolvedKeyPromise;
  };

  return {
    name: "googleCloudKmsSigning",
    async getPublicKey() {
      const { publicKey } = await resolveKey();
      return { publicKey };
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error(
          "Google Cloud KMS signing messages must be exactly 32 bytes.",
        );
      }

      const [client, key] = await Promise.all([resolveClient(), resolveKey()]);
      const digest = createHash("sha256").update(message).digest();
      let response: GoogleSignResponse;
      try {
        [response] = (await client.asymmetricSign({
          name: keyVersion,
          digest: { sha256: digest },
          digestCrc32c: { value: crc32c(digest) },
        })) as readonly [GoogleSignResponse];
      } catch {
        throw new Error("Google Cloud KMS failed to sign the bundle message.");
      }

      if (
        response.name !== keyVersion ||
        response.verifiedDigestCrc32c !== true ||
        !(response.signature instanceof Uint8Array) ||
        response.signature.byteLength === 0 ||
        !checksumMatches(response.signature, response.signatureCrc32c)
      ) {
        throw new Error(
          "Google Cloud KMS returned an invalid signing response.",
        );
      }
      if (!verify("RSA-SHA256", message, key.publicKey, response.signature)) {
        throw new Error(
          "Google Cloud KMS returned an unverifiable bundle signature.",
        );
      }

      return { signature: new Uint8Array(response.signature) };
    },
  };
};

import { createHash, createPublicKey, verify } from "node:crypto";

import { KeyManagementServiceClient, protos } from "@google-cloud/kms";
import type { BundleSigningPlugin } from "@hot-updater/plugin-core";
import crc32c from "fast-crc32c";

const KEY_VERSION_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/u;

const Algorithms =
  protos.google.cloud.kms.v1.CryptoKeyVersion.CryptoKeyVersionAlgorithm;
const SUPPORTED_ALGORITHMS = new Set<unknown>([
  Algorithms.RSA_SIGN_PKCS1_2048_SHA256,
  Algorithms.RSA_SIGN_PKCS1_3072_SHA256,
  Algorithms.RSA_SIGN_PKCS1_4096_SHA256,
  "RSA_SIGN_PKCS1_2048_SHA256",
  "RSA_SIGN_PKCS1_3072_SHA256",
  "RSA_SIGN_PKCS1_4096_SHA256",
]);

export interface FirebaseKmsSigningOptions {
  /** Version-pinned Google Cloud KMS asymmetric signing key resource name. */
  keyVersion: string;
  /** Project-relative path where Hot Updater stores the public key. */
  publicKeyPath: string;
}

interface ResolvedKmsKey {
  publicKey: string;
}

const checksumMatches = (
  value: Uint8Array | string,
  checksum: { value?: unknown } | null | undefined,
) => {
  if (checksum?.value === undefined || checksum.value === null) {
    return false;
  }
  return (
    crc32c.calculate(typeof value === "string" ? value : Buffer.from(value)) ===
    Number(checksum.value)
  );
};

const invalidPublicKeyResponse = () =>
  new Error(
    "Firebase Google Cloud KMS returned an invalid signing public key response.",
  );

const unsupportedSigningKey = () =>
  new Error(
    "Firebase Google Cloud KMS key does not support RSA-SHA256 bundle signing.",
  );

const loadPublicKey = async (
  client: KeyManagementServiceClient,
  keyVersion: string,
): Promise<ResolvedKmsKey> => {
  let response: protos.google.cloud.kms.v1.IPublicKey;
  try {
    [response] = await client.getPublicKey({ name: keyVersion });
  } catch {
    throw new Error(
      "Failed to load the Firebase Google Cloud KMS signing public key.",
    );
  }

  if (
    response.name !== keyVersion ||
    typeof response.pem !== "string" ||
    response.pem.length === 0 ||
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
    if (publicKey.asymmetricKeyType !== "rsa") {
      throw new Error("not rsa");
    }
    return {
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
  } catch {
    throw invalidPublicKeyResponse();
  }
};

/**
 * Creates a bundle signer backed by a version-pinned Google Cloud KMS key in a
 * Firebase project. The private key never leaves Cloud KMS.
 */
export const firebaseKmsSigning = ({
  keyVersion,
  publicKeyPath,
}: FirebaseKmsSigningOptions): BundleSigningPlugin => {
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error(
      "Firebase Google Cloud KMS signing requires a version-pinned key resource name.",
    );
  }
  if (publicKeyPath.trim().length === 0) {
    throw new Error(
      "Firebase Google Cloud KMS signing public key path is required.",
    );
  }

  const client = new KeyManagementServiceClient();
  let resolvedKeyPromise: Promise<ResolvedKmsKey> | undefined;
  const resolveKey = () => {
    if (resolvedKeyPromise) {
      return resolvedKeyPromise;
    }
    resolvedKeyPromise = loadPublicKey(client, keyVersion).catch((error) => {
      resolvedKeyPromise = undefined;
      throw error;
    });
    return resolvedKeyPromise;
  };

  return {
    name: "firebaseKmsSigning",
    publicKeyPath,
    async getPublicKey() {
      const { publicKey } = await resolveKey();
      return { publicKey };
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error(
          "Firebase Google Cloud KMS signing messages must be exactly 32 bytes.",
        );
      }

      const { publicKey } = await resolveKey();
      const digest = createHash("sha256").update(message).digest();
      let response: protos.google.cloud.kms.v1.IAsymmetricSignResponse;
      try {
        [response] = await client.asymmetricSign({
          name: keyVersion,
          digest: { sha256: digest },
          digestCrc32c: { value: crc32c.calculate(digest) },
        });
      } catch {
        throw new Error(
          "Firebase Google Cloud KMS failed to sign the bundle message.",
        );
      }

      if (
        response.name !== keyVersion ||
        response.verifiedDigestCrc32c !== true ||
        !(response.signature instanceof Uint8Array) ||
        response.signature.byteLength === 0 ||
        !checksumMatches(response.signature, response.signatureCrc32c)
      ) {
        throw new Error(
          "Firebase Google Cloud KMS returned an invalid signing response.",
        );
      }

      if (!verify("RSA-SHA256", message, publicKey, response.signature)) {
        throw new Error(
          "Firebase Google Cloud KMS returned an unverifiable bundle signature.",
        );
      }

      return { signature: new Uint8Array(response.signature) };
    },
  };
};

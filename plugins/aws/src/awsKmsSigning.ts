import { createPublicKey, verify } from "node:crypto";

import {
  GetPublicKeyCommand,
  type GetPublicKeyCommandOutput,
  KMSClient,
  type KMSClientConfig,
  SignCommand,
  type SignCommandOutput,
} from "@aws-sdk/client-kms";
import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

import { applyKmsRuntimeAwsConfig } from "./runtimeAwsConfig";

const SIGNING_ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256" as const;

export interface AwsKmsSigningOptions extends KMSClientConfig {
  /** AWS KMS asymmetric RSA signing key ARN, ID, or alias. */
  keyId: string;
}

interface ResolvedKmsKey {
  canonicalKeyId: string;
  publicKey: string;
}

const invalidPublicKeyResponse = () =>
  new Error("AWS KMS returned an invalid signing public key response.");

const unsupportedSigningKey = () =>
  new Error("AWS KMS key does not support RSA-SHA256 bundle signing.");

const loadPublicKey = async (
  client: KMSClient,
  requestedKeyId: string,
): Promise<ResolvedKmsKey> => {
  let response: GetPublicKeyCommandOutput;
  try {
    response = await client.send(
      new GetPublicKeyCommand({ KeyId: requestedKeyId }),
    );
  } catch {
    throw new Error("Failed to load the AWS KMS signing public key.");
  }

  if (
    typeof response.KeyId !== "string" ||
    response.KeyId.trim().length === 0 ||
    !(response.PublicKey instanceof Uint8Array) ||
    response.PublicKey.byteLength === 0
  ) {
    throw invalidPublicKeyResponse();
  }

  if (
    response.KeyUsage !== "SIGN_VERIFY" ||
    !["RSA_2048", "RSA_3072", "RSA_4096"].includes(response.KeySpec ?? "") ||
    !response.SigningAlgorithms?.includes(SIGNING_ALGORITHM)
  ) {
    throw unsupportedSigningKey();
  }

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({
      format: "der",
      key: Buffer.from(response.PublicKey),
      type: "spki",
    });
  } catch {
    throw invalidPublicKeyResponse();
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw unsupportedSigningKey();
  }

  return {
    canonicalKeyId: response.KeyId,
    publicKey: key.export({ format: "pem", type: "spki" }).toString(),
  };
};

/**
 * Creates a bundle signer backed by an AWS KMS asymmetric RSA signing key.
 * The private key never leaves KMS.
 */
export const awsKmsSigning = ({
  keyId,
  ...clientConfig
}: AwsKmsSigningOptions): BundleSigningPlugin => {
  if (keyId.trim().length === 0) {
    throw new Error("AWS KMS signing key ID is required.");
  }

  const client = new KMSClient(applyKmsRuntimeAwsConfig(clientConfig));
  let resolvedKeyPromise: Promise<ResolvedKmsKey> | undefined;

  const resolveKey = () => {
    if (resolvedKeyPromise) {
      return resolvedKeyPromise;
    }

    resolvedKeyPromise = loadPublicKey(client, keyId).catch((error) => {
      resolvedKeyPromise = undefined;
      throw error;
    });
    return resolvedKeyPromise;
  };

  return {
    name: "awsKmsSigning",
    async getPublicKey() {
      const { publicKey } = await resolveKey();
      return { publicKey };
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error("AWS KMS signing messages must be exactly 32 bytes.");
      }

      const { canonicalKeyId, publicKey } = await resolveKey();
      let response: SignCommandOutput;
      try {
        response = await client.send(
          new SignCommand({
            KeyId: canonicalKeyId,
            Message: message,
            MessageType: "RAW",
            SigningAlgorithm: SIGNING_ALGORITHM,
          }),
        );
      } catch {
        throw new Error("AWS KMS failed to sign the bundle message.");
      }

      if (
        response.KeyId !== canonicalKeyId ||
        response.SigningAlgorithm !== SIGNING_ALGORITHM ||
        !(response.Signature instanceof Uint8Array) ||
        response.Signature.byteLength === 0
      ) {
        throw new Error("AWS KMS returned an invalid signing response.");
      }

      if (!verify("RSA-SHA256", message, publicKey, response.Signature)) {
        throw new Error("AWS KMS returned an unverifiable bundle signature.");
      }

      return { signature: new Uint8Array(response.Signature) };
    },
  };
};

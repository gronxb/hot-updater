import { createPublicKey, verify } from "node:crypto";

import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  CryptographyClient,
  KeyClient,
  parseKeyVaultKeyIdentifier,
  type KeyVaultKey,
} from "@azure/keyvault-keys";
import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

const SIGNING_ALGORITHM = "RS256" as const;

export interface KeyVaultSigningOptions {
  /** Version-pinned Azure Key Vault or Managed HSM RSA key identifier. */
  readonly keyId: string;
  /** Checked-in RSA SPKI public key used as the native trust anchor. */
  readonly publicKeyPath: string;
  /** Defaults to Azure's standard credential chain. */
  readonly credential?: TokenCredential;
}

interface ResolvedKey {
  publicKey: string;
}

const invalidPublicKeyResponse = () =>
  new Error("Azure Key Vault returned an invalid signing public key response.");

const unsupportedSigningKey = () =>
  new Error("Azure Key Vault key does not support RSA-SHA256 bundle signing.");

const parseVersionedKeyId = (keyId: string) => {
  try {
    const url = new URL(keyId);
    const identifier = parseKeyVaultKeyIdentifier(keyId);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !identifier.version ||
      identifier.sourceId !== keyId
    ) {
      throw new Error("not versioned");
    }
    return identifier;
  } catch {
    throw new Error(
      "Azure Key Vault signing requires a version-pinned HTTPS key identifier.",
    );
  }
};

const toPublicKey = (response: KeyVaultKey, keyId: string) => {
  if (
    response.id !== keyId ||
    response.properties.version === undefined ||
    response.properties.enabled === false ||
    !(response.key?.n instanceof Uint8Array) ||
    response.key.n.byteLength === 0 ||
    !(response.key.e instanceof Uint8Array) ||
    response.key.e.byteLength === 0
  ) {
    throw invalidPublicKeyResponse();
  }

  if (
    response.properties.exportable === true ||
    !["RSA", "RSA-HSM"].includes(response.keyType ?? "") ||
    !response.keyOperations?.includes("sign")
  ) {
    throw unsupportedSigningKey();
  }

  try {
    const key = createPublicKey({
      format: "jwk",
      key: {
        e: Buffer.from(response.key.e).toString("base64url"),
        kty: "RSA",
        n: Buffer.from(response.key.n).toString("base64url"),
      },
    });
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("not rsa");
    }
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw invalidPublicKeyResponse();
  }
};

/** Creates a bundle signer backed by a version-pinned Azure Key Vault key. */
export const keyVaultSigning = ({
  keyId,
  publicKeyPath,
  credential = new DefaultAzureCredential(),
}: KeyVaultSigningOptions): BundleSigningPlugin => {
  const identifier = parseVersionedKeyId(keyId);
  if (!publicKeyPath.trim()) {
    throw new Error("Azure Key Vault signing public key path is required.");
  }

  const keyClient = new KeyClient(identifier.vaultUrl, credential);
  const cryptographyClient = new CryptographyClient(keyId, credential);
  let resolvedKey: Promise<ResolvedKey> | undefined;

  const getResolvedKey = () => {
    if (resolvedKey) return resolvedKey;

    resolvedKey = keyClient
      .getKey(identifier.name, { version: identifier.version })
      .then((response) => ({ publicKey: toPublicKey(response, keyId) }))
      .catch((error) => {
        resolvedKey = undefined;
        if (
          error instanceof Error &&
          (error.message === invalidPublicKeyResponse().message ||
            error.message === unsupportedSigningKey().message)
        ) {
          throw error;
        }
        throw new Error(
          "Failed to load the Azure Key Vault signing public key.",
        );
      });
    return resolvedKey;
  };

  return {
    name: "keyVaultSigning",
    publicKeyPath,
    async getPublicKey() {
      return getResolvedKey();
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error(
          "Azure Key Vault signing messages must be exactly 32 bytes.",
        );
      }

      const { publicKey } = await getResolvedKey();
      let response: Awaited<ReturnType<typeof cryptographyClient.signData>>;
      try {
        response = await cryptographyClient.signData(
          SIGNING_ALGORITHM,
          message,
        );
      } catch {
        throw new Error("Azure Key Vault failed to sign the bundle message.");
      }

      if (
        response.algorithm !== SIGNING_ALGORITHM ||
        response.keyID !== keyId ||
        !(response.result instanceof Uint8Array) ||
        response.result.byteLength === 0
      ) {
        throw new Error(
          "Azure Key Vault returned an invalid signing response.",
        );
      }

      if (!verify("RSA-SHA256", message, publicKey, response.result)) {
        throw new Error(
          "Azure Key Vault returned an unverifiable bundle signature.",
        );
      }
      return { signature: new Uint8Array(response.result) };
    },
  };
};

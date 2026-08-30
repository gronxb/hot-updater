import { createPublicKey, verify } from "node:crypto";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

const SIGNING_ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256" as const;

export interface AwsKmsSigningOptions {
  /** AWS KMS asymmetric RSA signing key ARN, ID, or alias. */
  readonly keyId: string;
  /** Checked-in RSA SPKI public key used as the native trust anchor. */
  readonly publicKeyPath: string;
  /** AWS region containing the signing key. */
  readonly region: string;
  /** Explicit HTTPS KMS endpoint, or an HTTP loopback endpoint for tests. */
  readonly endpoint?: string;
}

interface AwsKmsClient {
  send(command: unknown): Promise<unknown>;
}

interface AwsKmsSdk {
  KMSClient: new (config: {
    endpoint?: string;
    ignoreConfiguredEndpointUrls: true;
    region: string;
  }) => AwsKmsClient;
  GetPublicKeyCommand: new (input: { KeyId: string }) => unknown;
  SignCommand: new (input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "RAW";
    SigningAlgorithm: typeof SIGNING_ALGORITHM;
  }) => unknown;
}

interface GetPublicKeyResponse {
  KeyId?: unknown;
  KeySpec?: unknown;
  KeyUsage?: unknown;
  PublicKey?: unknown;
  SigningAlgorithms?: unknown;
}

interface SignResponse {
  KeyId?: unknown;
  Signature?: unknown;
  SigningAlgorithm?: unknown;
}

interface AwsKmsRuntime {
  client: AwsKmsClient;
  sdk: AwsKmsSdk;
}

interface ResolvedAwsKmsKey {
  canonicalKeyId: string;
  publicKey: string;
}

const invalidPublicKeyResponse = () =>
  new Error("AWS KMS returned an invalid signing public key response.");

const unsupportedSigningKey = () =>
  new Error("AWS KMS key does not support RSA-SHA256 bundle signing.");

const resolveEndpoint = (endpoint: string | undefined) => {
  if (endpoint === undefined) {
    return undefined;
  }

  const value = endpoint.trim();
  if (!value) {
    throw new Error("AWS KMS signing endpoint must not be empty.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AWS KMS signing endpoint must be a valid URL.");
  }

  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(
    url.hostname,
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "AWS KMS signing endpoint must use HTTPS or an HTTP loopback URL without credentials, a query, or a fragment.",
    );
  }

  return url.toString();
};

const loadAwsKmsSdk = async (): Promise<AwsKmsSdk> => {
  try {
    return (await import("@aws-sdk/client-kms")) as unknown as AwsKmsSdk;
  } catch {
    throw new Error(
      "awsKmsSigning requires the optional @aws-sdk/client-kms package.",
    );
  }
};

const loadPublicKey = async (
  runtime: AwsKmsRuntime,
  requestedKeyId: string,
): Promise<ResolvedAwsKmsKey> => {
  let response: GetPublicKeyResponse;
  try {
    response = (await runtime.client.send(
      new runtime.sdk.GetPublicKeyCommand({ KeyId: requestedKeyId }),
    )) as GetPublicKeyResponse;
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
    !["RSA_2048", "RSA_3072", "RSA_4096"].includes(
      typeof response.KeySpec === "string" ? response.KeySpec : "",
    ) ||
    !Array.isArray(response.SigningAlgorithms) ||
    !response.SigningAlgorithms.includes(SIGNING_ALGORITHM)
  ) {
    throw unsupportedSigningKey();
  }

  try {
    const key = createPublicKey({
      format: "der",
      key: Buffer.from(response.PublicKey),
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("unsupported key");
    }
    return {
      canonicalKeyId: response.KeyId,
      publicKey: key.export({ format: "pem", type: "spki" }).toString(),
    };
  } catch {
    throw invalidPublicKeyResponse();
  }
};

/** Creates a bundle signer backed by an AWS KMS asymmetric RSA key. */
export const awsKmsSigning = ({
  endpoint,
  keyId,
  publicKeyPath,
  region,
}: AwsKmsSigningOptions): BundleSigningPlugin => {
  if (!keyId.trim()) {
    throw new Error("AWS KMS signing key ID is required.");
  }
  if (!publicKeyPath.trim()) {
    throw new Error("AWS KMS signing public key path is required.");
  }
  if (!region.trim()) {
    throw new Error("AWS KMS signing region is required.");
  }
  const resolvedKeyId = keyId.trim();
  const resolvedRegion = region.trim();
  const resolvedEndpoint = resolveEndpoint(endpoint);

  let runtimePromise: Promise<AwsKmsRuntime> | undefined;
  const resolveRuntime = () => {
    if (runtimePromise) return runtimePromise;
    runtimePromise = loadAwsKmsSdk()
      .then((sdk) => ({
        client: new sdk.KMSClient({
          endpoint: resolvedEndpoint,
          ignoreConfiguredEndpointUrls: true,
          region: resolvedRegion,
        }),
        sdk,
      }))
      .catch((error) => {
        runtimePromise = undefined;
        throw error;
      });
    return runtimePromise;
  };

  let resolvedKeyPromise: Promise<ResolvedAwsKmsKey> | undefined;
  const resolveKey = () => {
    if (resolvedKeyPromise) return resolvedKeyPromise;
    resolvedKeyPromise = resolveRuntime()
      .then((runtime) => loadPublicKey(runtime, resolvedKeyId))
      .catch((error) => {
        resolvedKeyPromise = undefined;
        throw error;
      });
    return resolvedKeyPromise;
  };

  return {
    name: "awsKmsSigning",
    publicKeyPath,
    async getPublicKey() {
      const { publicKey } = await resolveKey();
      return { publicKey };
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error("AWS KMS signing messages must be exactly 32 bytes.");
      }

      const [runtime, key] = await Promise.all([
        resolveRuntime(),
        resolveKey(),
      ]);
      let response: SignResponse;
      try {
        response = (await runtime.client.send(
          new runtime.sdk.SignCommand({
            KeyId: key.canonicalKeyId,
            Message: message,
            MessageType: "RAW",
            SigningAlgorithm: SIGNING_ALGORITHM,
          }),
        )) as SignResponse;
      } catch {
        throw new Error("AWS KMS failed to sign the bundle message.");
      }

      if (
        response.KeyId !== key.canonicalKeyId ||
        response.SigningAlgorithm !== SIGNING_ALGORITHM ||
        !(response.Signature instanceof Uint8Array) ||
        response.Signature.byteLength === 0
      ) {
        throw new Error("AWS KMS returned an invalid signing response.");
      }
      if (!verify("RSA-SHA256", message, key.publicKey, response.Signature)) {
        throw new Error("AWS KMS returned an unverifiable bundle signature.");
      }

      return { signature: new Uint8Array(response.Signature) };
    },
  };
};

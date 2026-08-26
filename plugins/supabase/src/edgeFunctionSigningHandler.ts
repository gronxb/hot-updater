import { createBundleSigningHandler } from "@hot-updater/plugin-core/internal";

const RSA_SHA256 = {
  hash: "SHA-256",
  name: "RSASSA-PKCS1-v1_5",
} as const;
const SUPPORTED_RSA_MODULUS_LENGTHS = new Set([2048, 3072, 4096]);
const SIGNING_PATH = "/_hot-updater/signing";
const FUNCTION_NAME = "[A-Za-z][A-Za-z0-9_-]*";
const SIGNING_PATH_PATTERN = new RegExp(
  `^(?:/functions/v1/${FUNCTION_NAME}|/${FUNCTION_NAME})?${SIGNING_PATH}$`,
  "u",
);

export interface CreateEdgeFunctionSigningHandlerOptions {
  request: Request;
  /**
   * PKCS#8 PEM stored in a Supabase Edge Function secret, or a non-extractable
   * RSA-SHA256 CryptoKey. PEM secrets remain readable by the function runtime.
   */
  privateKey: string | CryptoKey;
  /** SPKI PEM public key paired with privateKey. */
  publicKey: string;
  /** Dedicated deploy-time token; never use an anon or service-role key. */
  signingToken: string;
}

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  new Uint8Array(value).buffer;

const importPrivateKey = async (privateKey: string): Promise<CryptoKey> => {
  const normalized = privateKey.trim();
  const match = normalized.match(
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----$/u,
  );
  if (!match) {
    throw new Error("Supabase bundle signing private key is invalid.");
  }

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(decodeBase64(match[1].replace(/\s/gu, ""))),
      RSA_SHA256,
      false,
      ["sign"],
    );
  } catch {
    throw new Error("Supabase bundle signing private key is invalid.");
  }
};

const validateCryptoKey = (privateKey: CryptoKey): CryptoKey => {
  const algorithm = privateKey.algorithm as RsaHashedKeyAlgorithm;
  if (
    privateKey.type !== "private" ||
    privateKey.extractable ||
    privateKey.usages.length !== 1 ||
    privateKey.usages[0] !== "sign" ||
    algorithm.name !== RSA_SHA256.name ||
    algorithm.hash?.name !== RSA_SHA256.hash ||
    !SUPPORTED_RSA_MODULUS_LENGTHS.has(algorithm.modulusLength)
  ) {
    throw new Error("Supabase bundle signing private key is invalid.");
  }
  return privateKey;
};

/**
 * Handles the fixed Hot Updater signing route in a dedicated Edge Function.
 *
 * A PEM private key supplied from Supabase secrets is readable by the Edge
 * Function runtime. It is imported as a non-extractable CryptoKey before use,
 * but this does not provide KMS/HSM isolation for the original secret value.
 */
export const createEdgeFunctionSigningHandler = async ({
  request,
  privateKey,
  publicKey,
  signingToken,
}: CreateEdgeFunctionSigningHandlerOptions): Promise<Response | null> => {
  const endpointPath = new URL(request.url).pathname;
  if (!SIGNING_PATH_PATTERN.test(endpointPath)) {
    return null;
  }

  return createBundleSigningHandler({
    endpointPath,
    publicKey,
    request,
    sign: async (message) => {
      const signingKey = validateCryptoKey(
        typeof privateKey === "string"
          ? await importPrivateKey(privateKey)
          : privateKey,
      );
      return new Uint8Array(
        await crypto.subtle.sign(
          RSA_SHA256,
          signingKey,
          toArrayBuffer(message),
        ),
      );
    },
    token: signingToken,
  });
};

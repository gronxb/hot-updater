import { createBundleSigningHandler } from "@hot-updater/plugin-core/internal";

export interface CreateWorkerSigningHandlerOptions {
  readonly request: Request;
  /** Full pathname used when the Worker is mounted below a route prefix. */
  readonly endpointPath?: string;
  /** Non-extractable, sign-only RSA private CryptoKey binding. */
  readonly privateKey: CryptoKey;
  /** RSA SPKI public key paired with privateKey. */
  readonly publicKey: string;
  /** Dedicated token used only for the signing endpoint. */
  readonly signingToken: string;
}

const assertPrivateSigningKey = (key: CryptoKey) => {
  const algorithm = key.algorithm;
  const hash = "hash" in algorithm ? algorithm.hash?.name : undefined;
  if (
    key.type !== "private" ||
    key.extractable ||
    algorithm.name !== "RSASSA-PKCS1-v1_5" ||
    hash !== "SHA-256" ||
    key.usages.length !== 1 ||
    key.usages[0] !== "sign"
  ) {
    throw new Error(
      "Cloudflare Worker signing requires a non-extractable, sign-only RSA-SHA256 private CryptoKey binding.",
    );
  }
};

/**
 * Handles the official remote signing path for a Cloudflare Worker.
 * Returns null when the request is outside the signing endpoint.
 */
export const createWorkerSigningHandler = async ({
  request,
  endpointPath = "/_hot-updater/signing",
  privateKey,
  publicKey,
  signingToken,
}: CreateWorkerSigningHandlerOptions): Promise<Response | null> => {
  return createBundleSigningHandler({
    endpointPath,
    publicKey,
    request,
    sign: async (message) => {
      assertPrivateSigningKey(privateKey);
      return new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, message),
      );
    },
    token: signingToken,
  });
};

import { createRemoteBundleSigningPlugin } from "@hot-updater/plugin-core/internal";

export interface WorkerSigningOptions {
  /** Base URL of the Cloudflare Worker that exposes the signing handler. */
  readonly workerUrl: string;
  /** Checked-in RSA SPKI public key used as the native trust anchor. */
  readonly publicKeyPath: string;
  /**
   * Dedicated signing token. Defaults lazily to
   * HOT_UPDATER_CLOUDFLARE_SIGNING_TOKEN.
   */
  readonly signingToken?: string;
}

/** Creates a bundle signer backed by a Cloudflare Worker CryptoKey binding. */
export const workerSigning = ({
  workerUrl,
  publicKeyPath,
  signingToken,
}: WorkerSigningOptions) =>
  createRemoteBundleSigningPlugin({
    endpoint: workerUrl,
    name: "cloudflareWorkerSigning",
    publicKeyPath,
    resolveToken: () => {
      const token =
        signingToken ?? process.env.HOT_UPDATER_CLOUDFLARE_SIGNING_TOKEN;
      if (!token?.trim()) {
        throw new Error("Cloudflare Worker signing token is required.");
      }
      return token;
    },
  });

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";
import { createRemoteBundleSigningPlugin } from "@hot-updater/plugin-core/internal";

const SIGNING_TOKEN_ENV = "HOT_UPDATER_SUPABASE_SIGNING_TOKEN";

export interface EdgeFunctionSigningOptions {
  /** Base URL of the dedicated Supabase signing Edge Function. */
  functionUrl: string;
  /** Project-relative path where Hot Updater stores the public key. */
  publicKeyPath: string;
  /** Dedicated deploy-time signing token. Defaults to the provider env var. */
  signingToken?: string;
}

/**
 * Creates a bundle signer backed by a dedicated Supabase Edge Function.
 *
 * The Edge Function stores the private key as a runtime-readable Supabase
 * secret. Use a dedicated signing token instead of an anon, service-role, or
 * Hot Updater API key.
 */
export const edgeFunctionSigning = ({
  functionUrl,
  publicKeyPath,
  signingToken,
}: EdgeFunctionSigningOptions): BundleSigningPlugin =>
  createRemoteBundleSigningPlugin({
    endpoint: functionUrl,
    name: "supabaseEdgeFunctionSigning",
    publicKeyPath,
    resolveToken: () => {
      const token = signingToken ?? process.env[SIGNING_TOKEN_ENV];
      if (!token) {
        throw new Error(
          `Supabase bundle signing requires signingToken or ${SIGNING_TOKEN_ENV}.`,
        );
      }
      return token;
    },
  });

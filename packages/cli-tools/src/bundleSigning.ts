import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  BundleSigningAdapter,
  SigningConfig,
} from "@hot-updater/plugin-core";

import { getCwd } from "./cwd.js";
import {
  createLocalSigningAdapter,
  getSigningSecrets,
  LocalSigningKeyError,
  normalizeSigningConfig,
} from "./localBundleSigning.js";

const FILE_HASH_PATTERN = /^[a-f\d]{64}$/iu;

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

export interface BundleSigningSession {
  readonly name: string;
  readonly publicKey: string;
  readonly signFileHash: (fileHash: string) => Promise<string>;
}

const parseRsaPublicKey = (publicKeyPEM: string): KeyObject => {
  try {
    const normalizedPublicKey = publicKeyPEM.trim();
    if (
      !normalizedPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
      !normalizedPublicKey.endsWith("-----END PUBLIC KEY-----")
    ) {
      throw new Error("not spki");
    }
    const publicKey = crypto.createPublicKey(normalizedPublicKey);
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("not rsa");
    }
    return publicKey;
  } catch {
    throw new Error(
      "Bundle signing public key must be a valid RSA SPKI PEM key with a modulus of at least 2048 bits.",
    );
  }
};

const exportPublicKey = (publicKey: KeyObject) =>
  publicKey.export({ type: "spki", format: "pem" }).toString();

export const readBundleSigningPublicKeyFile = async (
  publicKeyPath: string,
  options: { readonly cwd?: string } = {},
): Promise<string> => {
  if (!publicKeyPath.trim()) {
    throw new Error("Bundle signing public key path is required.");
  }
  try {
    const publicKeyPEM = await fs.readFile(
      resolvePath(options.cwd ?? getCwd(), publicKeyPath),
      "utf8",
    );
    return exportPublicKey(parseRsaPublicKey(publicKeyPEM));
  } catch {
    throw new Error("Failed to read the bundle signing public key file.");
  }
};

/**
 * `remoteSigning`'s errors with a reason it wrote itself, by name, as it may
 * come from another copy of plugin-core, and the local signer's errors that
 * name its secret. Any other signing adapter error is redacted: it may quote
 * key material.
 */
const REMOTE_SIGNING_ERROR_NAME = "HotUpdaterRemoteSigningError";

const signingFailure = (summary: string, error: unknown) =>
  new Error(
    error instanceof Error &&
      (error.name === REMOTE_SIGNING_ERROR_NAME ||
        error instanceof LocalSigningKeyError)
      ? `${summary} ${error.message}`
      : summary,
  );

/**
 * The local signer of each config's `signing` that reads its private key
 * from a secret, so the commands of one run that sign and derive the public
 * key read the secret once.
 */
const secretSigners = new WeakMap<object, BundleSigningAdapter>();

const getSigningProvider = (
  signing: SigningConfig | undefined,
): BundleSigningAdapter | null => {
  const normalized = normalizeSigningConfig(signing);
  if (!normalized) return null;
  if (!("enabled" in normalized)) return normalized;
  if (normalized.privateKey === undefined) {
    return createLocalSigningAdapter(normalized);
  }
  const key = signing as object;
  const cached = secretSigners.get(key);
  if (cached) return cached;
  // The config's own adapter when loadConfig resolved `signing`, else the
  // configured one.
  const local = createLocalSigningAdapter(normalized, {
    secrets: getSigningSecrets(key),
  });
  secretSigners.set(key, local);
  return local;
};

const getProviderPublicKey = async (
  provider: BundleSigningAdapter,
  cwd: string,
) => {
  try {
    const result = await provider.getPublicKey({ cwd });
    if (!result || typeof result.publicKey !== "string") {
      throw new Error("invalid result");
    }
    return parseRsaPublicKey(result.publicKey);
  } catch (error) {
    throw signingFailure(
      "Failed to resolve the bundle signing provider public key.",
      error,
    );
  }
};

const createMemoizedSigner = ({
  publicKey,
  sign,
}: {
  publicKey: KeyObject;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}) => {
  const signatures = new Map<string, Promise<string>>();

  return (fileHash: string): Promise<string> => {
    if (!FILE_HASH_PATTERN.test(fileHash)) {
      return Promise.reject(
        new Error(
          "Bundle signing requires a 64-character hexadecimal file hash.",
        ),
      );
    }

    const normalizedFileHash = fileHash.toLowerCase();
    const cached = signatures.get(normalizedFileHash);
    if (cached) {
      return cached;
    }

    const pending = (async () => {
      const message = Buffer.from(normalizedFileHash, "hex");
      let signature: Uint8Array;
      try {
        signature = await sign(new Uint8Array(message));
      } catch (error) {
        throw signingFailure(
          "Bundle signing provider failed to sign the file hash.",
          error,
        );
      }

      if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
        throw new Error(
          "Bundle signing provider returned an invalid signature.",
        );
      }

      if (!crypto.verify("RSA-SHA256", message, publicKey, signature)) {
        throw new Error(
          "Bundle signing provider returned a signature that does not match the configured public key.",
        );
      }

      return Buffer.from(signature).toString("base64");
    })().catch((error) => {
      signatures.delete(normalizedFileHash);
      throw error;
    });

    signatures.set(normalizedFileHash, pending);
    return pending;
  };
};

const preparePluginSigning = async (
  signing: BundleSigningAdapter,
  cwd: string,
): Promise<BundleSigningSession> => {
  const providerPublicKey = await getProviderPublicKey(signing, cwd);

  return {
    name: signing.name,
    publicKey: exportPublicKey(providerPublicKey),
    signFileHash: createMemoizedSigner({
      publicKey: providerPublicKey,
      sign: async (message) => {
        const result = await signing.sign({ cwd, message });
        return result.signature;
      },
    }),
  };
};

export const prepareBundleSigning = async (
  signing: SigningConfig | undefined,
  options: { readonly cwd?: string } = {},
): Promise<BundleSigningSession | null> => {
  const provider = getSigningProvider(signing);
  if (!provider) {
    return null;
  }
  return preparePluginSigning(provider, options.cwd ?? getCwd());
};

/** Resolves the public identity of the configured bundle signer. */
export const getBundleSigningPublicKey = async (
  signing: SigningConfig | undefined,
  options: { readonly cwd?: string } = {},
): Promise<string | null> => {
  const provider = getSigningProvider(signing);
  if (!provider) return null;
  return exportPublicKey(
    await getProviderPublicKey(provider, options.cwd ?? getCwd()),
  );
};

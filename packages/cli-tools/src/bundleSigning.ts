import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { SigningConfig } from "@hot-updater/plugin-core";

import { getCwd } from "./cwd.js";
import {
  createLocalSigningPlugin,
  normalizeSigningConfig,
} from "./localBundleSigning.js";

const FILE_HASH_PATTERN = /^[a-f\d]{64}$/iu;

export interface BundleSigningSession {
  readonly name: string;
  readonly publicKey: string;
  readonly signFileHash: (fileHash: string) => Promise<string>;
}

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

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

const publicKeysMatch = (left: KeyObject, right: KeyObject) => {
  const leftDer = left.export({ type: "spki", format: "der" });
  const rightDer = right.export({ type: "spki", format: "der" });
  return (
    leftDer.byteLength === rightDer.byteLength &&
    crypto.timingSafeEqual(leftDer, rightDer)
  );
};

const readKeyFile = async (cwd: string, filePath: string) => {
  try {
    return await fs.readFile(resolvePath(cwd, filePath), "utf8");
  } catch {
    throw new Error("Failed to read the bundle signing public key file.");
  }
};

const getProviderPublicKey = async (
  provider: ReturnType<typeof createLocalSigningPlugin>,
  cwd: string,
) => {
  try {
    const result = await provider.getPublicKey({ cwd });
    if (!result || typeof result.publicKey !== "string") {
      throw new Error("invalid result");
    }
    return parseRsaPublicKey(result.publicKey);
  } catch {
    throw new Error(
      "Failed to resolve the bundle signing provider public key.",
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
      } catch {
        throw new Error(
          "Bundle signing provider failed to sign the file hash.",
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
  signing: ReturnType<typeof createLocalSigningPlugin>,
  cwd: string,
): Promise<BundleSigningSession> => {
  const [configuredPublicKeyPEM, providerPublicKey] = await Promise.all([
    signing.publicKeyPath === undefined
      ? undefined
      : readKeyFile(cwd, signing.publicKeyPath),
    getProviderPublicKey(signing, cwd),
  ]);
  const configuredPublicKey =
    configuredPublicKeyPEM === undefined
      ? providerPublicKey
      : parseRsaPublicKey(configuredPublicKeyPEM);

  if (!publicKeysMatch(configuredPublicKey, providerPublicKey)) {
    throw new Error(
      "Bundle signing provider public key does not match publicKeyPath.",
    );
  }

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
  const normalized = normalizeSigningConfig(signing);
  if (!normalized) {
    return null;
  }

  const cwd = options.cwd ?? getCwd();
  return preparePluginSigning(
    "enabled" in normalized ? createLocalSigningPlugin(normalized) : normalized,
    cwd,
  );
};

/** Resolves the native trust anchor without calling a remote signing provider. */
export const getBundleSigningPublicKey = async (
  signing: SigningConfig | undefined,
  options: { readonly cwd?: string } = {},
): Promise<string | null> => {
  const normalized = normalizeSigningConfig(signing);
  if (!normalized) return null;
  const cwd = options.cwd ?? getCwd();
  if (normalized.publicKeyPath !== undefined) {
    return exportPublicKey(
      parseRsaPublicKey(await readKeyFile(cwd, normalized.publicKeyPath)),
    );
  }
  if ("enabled" in normalized) {
    try {
      const { publicKey } = await createLocalSigningPlugin(
        normalized,
      ).getPublicKey({ cwd });
      return exportPublicKey(parseRsaPublicKey(publicKey));
    } catch {
      // v0 local builds can use the generated sibling public key without the private key.
      return exportPublicKey(
        parseRsaPublicKey(
          await readKeyFile(
            cwd,
            path.join(
              path.dirname(normalized.privateKeyPath),
              "public-key.pem",
            ),
          ),
        ),
      );
    }
  }
  throw new Error("Bundle signing plugins require publicKeyPath.");
};

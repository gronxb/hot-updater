import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  BundleSigningPlugin,
  SigningConfig,
} from "@hot-updater/plugin-core";

import { getCwd } from "./cwd.js";

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
    if (publicKey.asymmetricKeyType !== "rsa") {
      throw new Error("not rsa");
    }
    return publicKey;
  } catch {
    throw new Error(
      "Bundle signing public key must be a valid RSA SPKI PEM key.",
    );
  }
};

const parseRsaPrivateKey = (privateKeyPEM: string): KeyObject => {
  try {
    const privateKey = crypto.createPrivateKey(privateKeyPEM);
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("not rsa");
    }
    return privateKey;
  } catch {
    throw new Error("Bundle signing private key must be a valid RSA PEM key.");
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

const readKeyFile = async (
  cwd: string,
  filePath: string,
  kind: "private" | "public",
) => {
  try {
    return await fs.readFile(resolvePath(cwd, filePath), "utf8");
  } catch {
    throw new Error(`Failed to read the bundle signing ${kind} key file.`);
  }
};

const getProviderPublicKey = async (provider: BundleSigningPlugin) => {
  try {
    const result = await provider.getPublicKey();
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

const prepareLegacySigning = async (
  signing: Extract<SigningConfig, { privateKeyPath: string }>,
  cwd: string,
): Promise<BundleSigningSession> => {
  const privateKeyPEM = await readKeyFile(
    cwd,
    signing.privateKeyPath,
    "private",
  );
  const privateKey = parseRsaPrivateKey(privateKeyPEM);
  const publicKey = crypto.createPublicKey(privateKey);

  return {
    name: "local-file",
    publicKey: exportPublicKey(publicKey),
    signFileHash: createMemoizedSigner({
      publicKey,
      sign: async (message) => crypto.sign("RSA-SHA256", message, privateKey),
    }),
  };
};

const prepareProviderSigning = async (
  signing: Extract<SigningConfig, { provider: BundleSigningPlugin }>,
  cwd: string,
): Promise<BundleSigningSession> => {
  const [configuredPublicKeyPEM, providerPublicKey] = await Promise.all([
    readKeyFile(cwd, signing.publicKeyPath, "public"),
    getProviderPublicKey(signing.provider),
  ]);
  const configuredPublicKey = parseRsaPublicKey(configuredPublicKeyPEM);

  if (!publicKeysMatch(configuredPublicKey, providerPublicKey)) {
    throw new Error(
      "Bundle signing provider public key does not match publicKeyPath.",
    );
  }

  return {
    name: signing.provider.name,
    publicKey: exportPublicKey(providerPublicKey),
    signFileHash: createMemoizedSigner({
      publicKey: providerPublicKey,
      sign: async (message) => {
        const result = await signing.provider.sign({ message });
        return result.signature;
      },
    }),
  };
};

export const prepareBundleSigning = async (
  signing: SigningConfig | undefined,
  options: { readonly cwd?: string } = {},
): Promise<BundleSigningSession | null> => {
  if (!signing?.enabled) {
    return null;
  }

  const cwd = options.cwd ?? getCwd();
  return "provider" in signing && signing.provider
    ? prepareProviderSigning(signing, cwd)
    : prepareLegacySigning(signing, cwd);
};

import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

export interface LocalSigningOptions {
  /** Path to an RSA private key in PEM format. */
  readonly privateKeyPath: string;
}

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

const loadPrivateKey = async (privateKeyPath: string): Promise<KeyObject> => {
  try {
    const privateKey = crypto.createPrivateKey(
      await fs.readFile(privateKeyPath, "utf8"),
    );
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("not rsa");
    }
    return privateKey;
  } catch {
    throw new Error("Failed to load the local bundle signing private key.");
  }
};

/** Signs bundles with a private key stored on the local filesystem. */
export const localSigning = ({
  privateKeyPath,
}: LocalSigningOptions): BundleSigningPlugin => {
  if (!privateKeyPath.trim()) {
    throw new Error("localSigning requires privateKeyPath.");
  }

  const publicKeyPath = path.join(
    path.dirname(privateKeyPath),
    "public-key.pem",
  );
  const privateKeys = new Map<string, Promise<KeyObject>>();

  const getPrivateKey = (cwd = process.cwd()) => {
    const resolvedPath = resolvePath(cwd, privateKeyPath);
    const cached = privateKeys.get(resolvedPath);
    if (cached) return cached;

    const pending = loadPrivateKey(resolvedPath).catch((error) => {
      privateKeys.delete(resolvedPath);
      throw error;
    });
    privateKeys.set(resolvedPath, pending);
    return pending;
  };

  return {
    name: "localSigning",
    publicKeyPath,
    async getPublicKey({ cwd } = {}) {
      const privateKey = await getPrivateKey(cwd);
      return {
        publicKey: crypto
          .createPublicKey(privateKey)
          .export({ format: "pem", type: "spki" })
          .toString(),
      };
    },
    async sign({ message, cwd }) {
      const privateKey = await getPrivateKey(cwd);
      return {
        signature: crypto.sign("RSA-SHA256", message, privateKey),
      };
    },
  };
};

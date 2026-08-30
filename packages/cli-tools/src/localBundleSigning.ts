import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  BundleSigningPlugin,
  LocalSigningConfig,
  SigningConfig,
} from "@hot-updater/plugin-core";

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

const loadPrivateKey = async (privateKeyPath: string): Promise<KeyObject> => {
  try {
    const privateKey = crypto.createPrivateKey(
      await fs.readFile(privateKeyPath, "utf8"),
    );
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("not rsa");
    }
    return privateKey;
  } catch {
    throw new Error("Failed to load the local bundle signing private key.");
  }
};

export const createLocalSigningPlugin = ({
  privateKeyPath,
  publicKeyPath,
}: Extract<LocalSigningConfig, { enabled: true }>): Omit<
  BundleSigningPlugin,
  "publicKeyPath"
> & { readonly publicKeyPath?: string } => {
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
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error(
          "Local bundle signing messages must be exactly 32 bytes.",
        );
      }
      const privateKey = await getPrivateKey(cwd);
      return {
        signature: crypto.sign("RSA-SHA256", message, privateKey),
      };
    },
  };
};

const invalidSigningConfig = () =>
  new Error(
    "Bundle signing must be a local key config or signing plugin. Omit signing to disable it.",
  );

export const normalizeSigningConfig = (
  signing: SigningConfig | undefined,
):
  | BundleSigningPlugin
  | Extract<LocalSigningConfig, { enabled: true }>
  | undefined => {
  if (signing === undefined) return undefined;
  if (typeof signing !== "object" || signing === null) {
    throw invalidSigningConfig();
  }

  const hasPrivateKeyPath = Reflect.has(signing, "privateKeyPath");
  const hasEnabled = Reflect.has(signing, "enabled");
  const hasPluginMembers = ["name", "getPublicKey", "sign"].some((key) =>
    Reflect.has(signing, key),
  );
  if ((hasPrivateKeyPath || hasEnabled) && hasPluginMembers) {
    throw new Error(
      "Bundle signing config cannot combine local signing fields with signing plugin fields.",
    );
  }

  if (!hasPluginMembers) {
    const hasUnsupportedMembers = Object.keys(signing).some(
      (key) =>
        key !== "enabled" &&
        key !== "privateKeyPath" &&
        key !== "publicKeyPath",
    );
    if (hasUnsupportedMembers) {
      throw new Error(
        "Local bundle signing accepts only enabled, privateKeyPath and publicKeyPath.",
      );
    }
    const enabled = Reflect.get(signing, "enabled");
    // v0 never enables signing merely because key paths are present.
    if (enabled === false || enabled === undefined) return undefined;
    if (enabled !== true) throw invalidSigningConfig();

    const privateKeyPath = Reflect.get(signing, "privateKeyPath");
    const publicKeyPath = Reflect.get(signing, "publicKeyPath");
    if (typeof privateKeyPath !== "string" || !privateKeyPath.trim()) {
      throw new Error("Enabled local bundle signing requires privateKeyPath.");
    }
    if (
      publicKeyPath !== undefined &&
      (typeof publicKeyPath !== "string" || !publicKeyPath.trim())
    ) {
      throw new Error(
        "Local bundle signing publicKeyPath must be a non-empty path when provided.",
      );
    }
    return {
      enabled: true,
      privateKeyPath,
      ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
    };
  }

  if (
    typeof Reflect.get(signing, "name") !== "string" ||
    typeof Reflect.get(signing, "publicKeyPath") !== "string" ||
    !(Reflect.get(signing, "publicKeyPath") as string).trim() ||
    typeof Reflect.get(signing, "getPublicKey") !== "function" ||
    typeof Reflect.get(signing, "sign") !== "function"
  ) {
    throw invalidSigningConfig();
  }

  return signing as BundleSigningPlugin;
};

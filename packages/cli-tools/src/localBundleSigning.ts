import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  BundleSigningAdapter,
  LocalSigningConfig,
  SecretsAdapter,
  SigningConfig,
} from "@hot-updater/plugin-core";

import { registerSecretValue } from "./secretMasking.js";
import {
  describeSecret,
  getConfiguredSecrets,
  parseSecretReference,
} from "./secrets.js";

/** The secret `keys generate --secret` stores the private key as by default. */
export const DEFAULT_SIGNING_KEY_SECRET = "bundle-signing-key";

/** Local signing enabled, with its private key from a file or a secret. */
export type EnabledLocalSigningConfig = Extract<
  LocalSigningConfig,
  { enabled: true }
>;

/**
 * A local signing failure whose message the CLI prints as it is: it names
 * the secret and how to store it, and quotes no key material.
 */
export class LocalSigningKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HotUpdaterLocalSigningKeyError";
  }
}

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

const parsePrivateKey = (pem: string): KeyObject => {
  try {
    const privateKey = crypto.createPrivateKey(pem);
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

const loadPrivateKeyFile = async (
  privateKeyPath: string,
): Promise<KeyObject> => {
  let pem: string;
  try {
    pem = await fs.readFile(privateKeyPath, "utf8");
  } catch {
    throw new Error("Failed to load the local bundle signing private key.");
  }
  return parsePrivateKey(pem);
};

/**
 * The private key the `secrets` adapter holds as `name`: masked in the CLI's
 * output before it is parsed, and kept only as a key object. A PEM written
 * on one line, with `\n` for its line breaks, as a `.env.hotupdater` value
 * or a CI variable may hold it, reads as the PEM.
 */
const loadPrivateKeySecret = async (
  secrets: SecretsAdapter,
  name: string,
  cwd: string,
): Promise<KeyObject> => {
  let value: string | undefined;
  try {
    const read = await secrets.get([name], { cwd });
    value = Object.hasOwn(read, name) ? read[name] : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LocalSigningKeyError(
      `The ${secrets.name} secrets adapter could not read the bundle signing key ${name}: ${reason}`,
      { cause: error },
    );
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new LocalSigningKeyError(
      `signing.privateKey reads the bundle signing key ${name}, which is not in the ${secrets.name} secrets adapter (${describeSecret(secrets, name)}). Set it to the RSA private key in PEM, or generate a key pair with \`npx hot-updater keys generate --secret ${name}\`.`,
    );
  }
  registerSecretValue(value);
  const pem = value.includes("\n") ? value : value.replaceAll("\\n", "\n");
  if (pem !== value) registerSecretValue(pem);
  try {
    return parsePrivateKey(pem);
  } catch {
    throw new LocalSigningKeyError(
      `The bundle signing key ${name} in the ${secrets.name} secrets adapter is not an RSA private key in PEM of at least 2048 bits.`,
    );
  }
};

/**
 * The built-in local signer. Its private key is read on first use, once:
 * from `privateKeyPath`, or from the config's `secrets` adapter for
 * `privateKey: "secret:<name>"`, and is never written anywhere.
 */
export const createLocalSigningAdapter = (
  config: EnabledLocalSigningConfig,
  { secrets }: { readonly secrets?: SecretsAdapter } = {},
): BundleSigningAdapter => {
  const privateKeys = new Map<string, Promise<KeyObject>>();
  const { privateKeyPath } = config;
  const secretName =
    privateKeyPath === undefined
      ? parseSecretReference(config.privateKey, "signing.privateKey")
      : undefined;
  const getPrivateKey = (cwd = process.cwd()) => {
    // A secret is read once, whatever the directory.
    const cacheKey =
      privateKeyPath === undefined ? "" : resolvePath(cwd, privateKeyPath);
    const cached = privateKeys.get(cacheKey);
    if (cached) return cached;

    const pending = (
      secretName === undefined
        ? loadPrivateKeyFile(cacheKey)
        : loadPrivateKeySecret(
            secrets ?? getConfiguredSecrets(),
            secretName,
            cwd,
          )
    ).catch((error) => {
      privateKeys.delete(cacheKey);
      throw error;
    });
    privateKeys.set(cacheKey, pending);
    return pending;
  };

  return {
    name: "localSigning",
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

/**
 * The `secrets` adapter of the config each normalized `privateKey` config
 * came from, so a config function's per-platform configs each read their
 * own store, whichever config loaded last.
 */
const signingSecrets = new WeakMap<object, SecretsAdapter>();

/** The `secrets` adapter `normalizeSigningConfig` bound `signing` to. */
export const getSigningSecrets = (
  signing: object,
): SecretsAdapter | undefined => signingSecrets.get(signing);

const invalidSigningConfig = () =>
  new Error(
    "Bundle signing must be a local key config or signing adapter. Omit signing to disable it.",
  );

export const normalizeSigningConfig = (
  signing: SigningConfig | undefined,
  { secrets }: { readonly secrets?: SecretsAdapter } = {},
): BundleSigningAdapter | EnabledLocalSigningConfig | undefined => {
  if (signing === undefined) return undefined;
  if (typeof signing !== "object" || signing === null) {
    throw invalidSigningConfig();
  }

  const hasLocalFields = ["enabled", "privateKeyPath", "privateKey"].some(
    (key) => Reflect.has(signing, key),
  );
  const hasPluginMembers = ["name", "getPublicKey", "sign"].some((key) =>
    Reflect.has(signing, key),
  );
  if (hasLocalFields && hasPluginMembers) {
    throw new Error(
      "Bundle signing config cannot combine local signing fields with signing adapter fields.",
    );
  }

  if (!hasPluginMembers) {
    const hasUnsupportedMembers = Object.keys(signing).some(
      (key) =>
        key !== "enabled" && key !== "privateKeyPath" && key !== "privateKey",
    );
    if (hasUnsupportedMembers) {
      throw new Error(
        "Local bundle signing accepts only enabled, and privateKeyPath or privateKey.",
      );
    }
    const enabled = Reflect.get(signing, "enabled");
    if (enabled === false) return undefined;
    if (enabled !== true) throw invalidSigningConfig();

    const privateKeyPath = Reflect.get(signing, "privateKeyPath");
    const privateKey = Reflect.get(signing, "privateKey");
    if (privateKeyPath !== undefined && privateKey !== undefined) {
      throw new Error(
        "Local bundle signing takes its private key from privateKeyPath or from privateKey, not both.",
      );
    }
    if (privateKey !== undefined) {
      if (typeof privateKey !== "string") {
        throw new Error(
          'signing.privateKey names a secret as secret:<name>, such as "secret:bundle-signing-key".',
        );
      }
      // Checks the reference only: loading a config reads no secret.
      parseSecretReference(privateKey, "signing.privateKey");
      const normalized = {
        enabled: true,
        privateKey: privateKey as `secret:${string}`,
      } as const;
      if (secrets) signingSecrets.set(normalized, secrets);
      return normalized;
    }
    if (typeof privateKeyPath !== "string" || !privateKeyPath.trim()) {
      throw new Error(
        'Enabled local bundle signing requires privateKeyPath, or privateKey as "secret:<name>".',
      );
    }
    return {
      enabled: true,
      privateKeyPath,
    };
  }

  if (
    typeof Reflect.get(signing, "name") !== "string" ||
    typeof Reflect.get(signing, "getPublicKey") !== "function" ||
    typeof Reflect.get(signing, "sign") !== "function"
  ) {
    throw invalidSigningConfig();
  }

  return signing as BundleSigningAdapter;
};

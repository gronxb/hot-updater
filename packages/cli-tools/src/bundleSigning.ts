import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  LocalSigningConfig,
  SecretRef,
  SecretsAdapter,
} from "@hot-updater/plugin-core";

import { describeMissingSecret } from "./credentialResolver.js";
import { getCwd } from "./cwd.js";
import { registerSecretValue } from "./secretMasking.js";
import { getConfiguredSecrets, isSecretRef } from "./secrets.js";

/** The secret `signing: secret("bundle-signing-key")` names, which `secrets issue` creates. */
export const BUNDLE_SIGNING_KEY_SECRET = "bundle-signing-key";

/** The command that creates and stores a bundle signing key. */
export const ISSUE_SIGNING_KEY_COMMAND = `npx hot-updater secrets issue ${BUNDLE_SIGNING_KEY_SECRET}`;

/** The command that stores a bundle signing key you have. */
export const PUT_SIGNING_KEY_COMMAND = `npx hot-updater secrets put ${BUNDLE_SIGNING_KEY_SECRET} <key.pem>`;

/** The command that stores the bundle signing key you have as `name`. */
export const bundleSigningPutCommand = (name: string): string =>
  `npx hot-updater secrets put ${name}${name === BUNDLE_SIGNING_KEY_SECRET ? "" : ` --kind ${BUNDLE_SIGNING_KEY_SECRET}`} <key.pem>`;

/** What deploy and doctor say when the config sets no `signing`. */
export const UNSIGNED_BUNDLES_WARNING = "Bundles are unsigned.";

/** The next step after `UNSIGNED_BUNDLES_WARNING`. */
export const UNSIGNED_BUNDLES_NEXT_STEP = "To sign them, run:";

/** What deploy and doctor say when `signing` is no shape it takes. */
export const INVALID_SIGNING_MESSAGE = `signing takes secret("${BUNDLE_SIGNING_KEY_SECRET}").`;

/** The next step after `INVALID_SIGNING_MESSAGE`. */
export const INVALID_SIGNING_NEXT_STEP = "Store your key:";

/**
 * The config's `signing`, read without reading any key:
 * - `on`: signs, with the private key from a secret or a file. The
 *   shorthand `secret("<name>")` is `{ enabled: true, privateKey }`;
 * - `off`: `{ enabled: false }`, which turns signing off on purpose;
 * - `unsigned`: no `signing`, which deploy and doctor warn about;
 * - `invalid`: any other value, such as a signing adapter of earlier
 *   releases, which deploy refuses rather than deploy unsigned.
 */
export type BundleSigningState =
  | {
      readonly status: "on";
      readonly key:
        | { readonly secret: string }
        | { readonly privateKeyPath: string };
    }
  | { readonly status: "off" }
  | { readonly status: "unsigned" }
  | { readonly status: "invalid"; readonly message: string };

const invalid = (message: string): BundleSigningState => ({
  status: "invalid",
  message,
});

const LOCAL_FIELDS = ["enabled", "privateKeyPath", "privateKey"];

export const readBundleSigningState = (
  signing: unknown,
): BundleSigningState => {
  if (signing === undefined) return { status: "unsigned" };
  if (isSecretRef(signing)) {
    return { status: "on", key: { secret: signing.name } };
  }
  if (
    typeof signing !== "object" ||
    signing === null ||
    !Object.keys(signing).every((key) => LOCAL_FIELDS.includes(key))
  ) {
    return invalid(INVALID_SIGNING_MESSAGE);
  }
  const { enabled, privateKey, privateKeyPath } =
    signing as Partial<LocalSigningConfig>;
  if (enabled === false) return { status: "off" };
  if (enabled !== true) return invalid(INVALID_SIGNING_MESSAGE);
  if (privateKey !== undefined && privateKeyPath !== undefined) {
    return invalid("signing takes privateKey or privateKeyPath, not both.");
  }
  if (privateKey !== undefined) {
    return isSecretRef(privateKey)
      ? { status: "on", key: { secret: privateKey.name } }
      : invalid('signing.privateKey takes secret("<name>").');
  }
  if (typeof privateKeyPath !== "string" || !privateKeyPath.trim()) {
    return invalid(
      'signing takes privateKeyPath, or privateKey as secret("<name>").',
    );
  }
  return { status: "on", key: { privateKeyPath } };
};

/** The `secret()` the config's `signing` reads its private key from, if any. */
export const bundleSigningSecretRef = (
  signing: unknown,
): SecretRef | undefined => {
  if (isSecretRef(signing)) return signing;
  const privateKey =
    typeof signing === "object" && signing !== null
      ? Reflect.get(signing, "privateKey")
      : undefined;
  return isSecretRef(privateKey) ? privateKey : undefined;
};

/**
 * A bundle signing failure whose message the CLI prints as it is: it names
 * the secret and the next step, and quotes no key material.
 */
export class BundleSigningKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HotUpdaterBundleSigningKeyError";
  }
}

const FILE_HASH_PATTERN = /^[a-f\d]{64}$/iu;

const resolvePath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

export interface BundleSigningSession {
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

/** The SPKI PEM of `key`, a public key or the private key it derives from. */
const exportPublicKey = (key: KeyObject) =>
  (key.type === "private" ? crypto.createPublicKey(key) : key)
    .export({ type: "spki", format: "pem" })
    .toString();

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

const parsePrivateKey = (pem: string): KeyObject => {
  const privateKey = crypto.createPrivateKey(pem);
  if (
    privateKey.asymmetricKeyType !== "rsa" ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error("not rsa");
  }
  return privateKey;
};

const loadPrivateKeyFile = async (file: string): Promise<KeyObject> => {
  try {
    return parsePrivateKey(await fs.readFile(file, "utf8"));
  } catch {
    // Neither the path nor the file's content: either may be private.
    throw new BundleSigningKeyError(
      "Failed to load the bundle signing private key from privateKeyPath.",
    );
  }
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
    throw new BundleSigningKeyError(
      `Couldn't read ${name} from the ${secrets.name} secrets adapter.\n${reason}`,
      { cause: error },
    );
  }
  // Never a new key: every shipped app rejects bundles it signs.
  if (typeof value !== "string" || !value.trim()) {
    throw new BundleSigningKeyError(
      describeMissingSecret(secrets, name, {
        command: bundleSigningPutCommand(name),
      }),
    );
  }
  registerSecretValue(value);
  const pem = value.includes("\n") ? value : value.replaceAll("\\n", "\n");
  if (pem !== value) registerSecretValue(pem);
  try {
    return parsePrivateKey(pem);
  } catch {
    throw new BundleSigningKeyError(
      [
        `${name} in the ${secrets.name} secrets adapter is no signing key.`,
        "Store an RSA private key in PEM, of 2048 bits or more.",
      ].join("\n"),
    );
  }
};

/**
 * The private keys each `signing` value has read, by file or by secrets
 * adapter, so the commands of one run that sign and derive the public key
 * read the key once.
 */
const privateKeys = new WeakMap<object, Map<unknown, Promise<KeyObject>>>();

export interface BundleSigningOptions {
  readonly cwd?: string;
  /** The config's `secrets` adapter; the configured one by default. */
  readonly secrets?: SecretsAdapter;
}

/**
 * The private key `signing` signs with, or null when it signs nothing.
 * Throws `INVALID_SIGNING_MESSAGE`, with the next step, for a value
 * `signing` doesn't take.
 */
const loadSigningKey = (
  signing: unknown,
  { cwd = getCwd(), secrets }: BundleSigningOptions,
): Promise<KeyObject> | null => {
  const state = readBundleSigningState(signing);
  if (state.status === "invalid") {
    throw new BundleSigningKeyError(
      `${state.message}\n${INVALID_SIGNING_NEXT_STEP} ${PUT_SIGNING_KEY_COMMAND}`,
    );
  }
  if (state.status !== "on") return null;

  const store = secrets ?? getConfiguredSecrets();
  const cacheKey =
    "secret" in state.key ? store : resolvePath(cwd, state.key.privateKeyPath);
  const cache = privateKeys.get(signing as object) ?? new Map();
  privateKeys.set(signing as object, cache);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const pending = (
    "secret" in state.key
      ? loadPrivateKeySecret(store, state.key.secret, cwd)
      : loadPrivateKeyFile(cacheKey as string)
  ).catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, pending);
  return pending;
};

const signingFailure = (summary: string, error: unknown) =>
  new Error(
    error instanceof BundleSigningKeyError
      ? error.message
      : `${summary} ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );

/**
 * Prepares the run's bundle signing: the public key the app must embed, and
 * a signer of SHA-256 file hashes that signs each hash once. Null when
 * `signing` is omitted or `{ enabled: false }`.
 */
export const prepareBundleSigning = async (
  signing: unknown,
  options: BundleSigningOptions = {},
): Promise<BundleSigningSession | null> => {
  const loading = loadSigningKey(signing, options);
  if (!loading) return null;
  let privateKey: KeyObject;
  try {
    privateKey = await loading;
  } catch (error) {
    throw signingFailure("Failed to read the bundle signing key.", error);
  }

  const signatures = new Map<string, string>();
  return {
    publicKey: exportPublicKey(privateKey),
    signFileHash: async (fileHash) => {
      if (!FILE_HASH_PATTERN.test(fileHash)) {
        throw new Error(
          "Bundle signing requires a 64-character hexadecimal file hash.",
        );
      }
      const normalized = fileHash.toLowerCase();
      const cached = signatures.get(normalized);
      if (cached) return cached;
      const signature = crypto
        .sign("RSA-SHA256", Buffer.from(normalized, "hex"), privateKey)
        .toString("base64");
      signatures.set(normalized, signature);
      return signature;
    },
  };
};

/**
 * The public key of the configured bundle signing key, in SPKI PEM; null
 * when `signing` signs nothing.
 */
export const getBundleSigningPublicKey = async (
  signing: unknown,
  options: BundleSigningOptions = {},
): Promise<string | null> => {
  const loading = loadSigningKey(signing, options);
  if (!loading) return null;
  try {
    return exportPublicKey(await loading);
  } catch (error) {
    throw signingFailure("Failed to read the bundle signing key.", error);
  }
};

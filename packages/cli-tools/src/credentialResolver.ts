import fs from "node:fs/promises";
import path from "node:path";

import { type CredentialFiles, createCredentialFiles } from "./credentialFiles";
import { getHotUpdaterEnvValue } from "./hotUpdaterEnv";
import { registerSecretValue } from "./secretMasking";
import { createVaultCredentialSource } from "./vaultCredentialSource";

export type { CredentialFiles } from "./credentialFiles";

/**
 * The credentials the CLI receives. A bundle signing key is never one of
 * them (the Console signs bundles remotely), and key/value deploy
 * credentials reach the CLI as environment variables.
 */
export interface Credentials {
  /** App Store Connect API key, for automatic signing and uploads. */
  "asc-api-key": {
    /** A 0600 temporary file or the path the user set. */
    readonly keyPath: string;
    readonly keyId: string;
    readonly issuerId: string;
  };
  /** Android release keystore, for Gradle signing. */
  "android-keystore": {
    /** A 0600 temporary file or the path the user set. */
    readonly storeFile: string;
    readonly storePassword: string;
    readonly keyAlias: string;
    readonly keyPassword: string;
  };
  /** Google Play service account, kept in memory. */
  "play-service-account": {
    readonly json: string;
  };
}

export type CredentialKind = keyof Credentials;

export interface CredentialRequest<TKind extends CredentialKind> {
  readonly kind: TKind;
  /**
   * The item's name, for a project with several items of one kind (such as
   * `widget-keystore`). Defaults to the kind. Environment overrides apply to
   * every item of a kind.
   */
  readonly name?: string;
}

/** A credential tagged with its kind, as a source returns it. */
export type SourcedCredential = {
  readonly [TKind in CredentialKind]: {
    readonly kind: TKind;
    readonly credential: Credentials[TKind];
  };
}[CredentialKind];

/**
 * Where a resolver finds a credential no environment override sets, such as
 * the Console vault. It returns the credential of `request.kind`, writes
 * file values with `files`, so they are 0600 and deleted with the resolver's
 * other files, and throws when it cannot provide the item.
 */
export type CredentialSource = (
  request: { readonly kind: CredentialKind; readonly name: string },
  context: { readonly files: CredentialFiles },
) => Promise<SourcedCredential>;

/**
 * Resolves the credentials a command needs. Commands call `dispose` in a
 * `finally` (or use `withCredentialResolver`); temporary files are also
 * deleted when the process exits.
 */
export interface CredentialResolver {
  resolve<TKind extends CredentialKind>(
    request: CredentialRequest<TKind>,
  ): Promise<Credentials[TKind]>;
  /**
   * Waits for resolutions in flight, then deletes every temporary file this
   * resolver wrote. The resolver resolves nothing after it.
   */
  dispose(): Promise<void>;
}

/**
 * The environment variables that override each kind, one entry per field.
 * A field with two names takes a file path or the file's contents; the path
 * wins when both are set.
 */
export const CREDENTIAL_ENV_NAMES = {
  "asc-api-key": [
    ["HOT_UPDATER_ASC_KEY_PATH", "HOT_UPDATER_ASC_KEY"],
    ["HOT_UPDATER_ASC_KEY_ID"],
    ["HOT_UPDATER_ASC_ISSUER_ID"],
  ],
  "android-keystore": [
    [
      "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
      "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
    ],
    ["HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD"],
    ["HOT_UPDATER_ANDROID_KEY_ALIAS"],
    ["HOT_UPDATER_ANDROID_KEY_PASSWORD"],
  ],
  "play-service-account": [
    [
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    ],
  ],
} as const satisfies Record<
  CredentialKind,
  readonly (readonly [string] | readonly [string, string])[]
>;

/** Passwords are read as set: trimming would change them. */
const UNTRIMMED_ENV_NAMES = new Set<string>([
  "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
  "HOT_UPDATER_ANDROID_KEY_PASSWORD",
]);

type EnvField = readonly string[];

const describeField = ([name, alternative]: EnvField) =>
  alternative ? `${name} (or ${alternative})` : name;

const describeFields = (fields: readonly EnvField[]) => {
  const described = fields.map(describeField);
  if (described.length <= 2) {
    return described.join(" and ");
  }
  return `${described.slice(0, -1).join(", ")}, and ${described.at(-1)}`;
};

/**
 * The sentence every "credential unavailable" message ends with: the
 * environment variables that provide `kind` without the vault.
 */
export const credentialOverrideHint = (kind: CredentialKind): string =>
  `Set ${describeFields(CREDENTIAL_ENV_NAMES[kind])} to provide ${kind} without the vault.`;

export class CredentialUnavailableError extends Error {
  readonly kind: CredentialKind;
  /** The environment variables that can provide this credential. */
  readonly envNames: readonly string[];

  constructor(
    kind: CredentialKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialUnavailableError";
    this.kind = kind;
    this.envNames = CREDENTIAL_ENV_NAMES[kind].flat();
  }
}

type EnvValue = { readonly name: string; readonly value: string };

const readEnvField = (
  env: Readonly<Record<string, string>>,
  field: EnvField,
): EnvValue | undefined => {
  for (const name of field) {
    const value = UNTRIMMED_ENV_NAMES.has(name)
      ? (process.env[name] ?? env[name]) || undefined
      : getHotUpdaterEnvValue(env, name);
    if (value !== undefined) {
      return { name, value };
    }
  }
  return undefined;
};

const readFileField = async (
  kind: CredentialKind,
  { name, value }: EnvValue,
) => {
  const filePath = path.resolve(value);
  const isReadableFile = await fs
    .stat(filePath)
    .then(async (stats) => {
      await fs.access(filePath, fs.constants.R_OK);
      return stats.isFile();
    })
    .catch(() => false);
  if (!isReadableFile) {
    throw new CredentialUnavailableError(
      kind,
      // The value is not echoed: it may be a credential set by mistake.
      `${name} does not point to a readable file.`,
    );
  }
  return filePath;
};

const parseServiceAccount = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const fromEnv: {
  readonly [TKind in CredentialKind]: (
    values: readonly EnvValue[],
    context: { readonly files: CredentialFiles; readonly name: string },
  ) => Promise<Credentials[TKind]>;
} = {
  "asc-api-key": async ([key, keyId, issuerId], { files }) => ({
    keyPath:
      key.name === "HOT_UPDATER_ASC_KEY_PATH"
        ? await readFileField("asc-api-key", key)
        : await files.write(
            `AuthKey_${keyId.value}.p8`,
            // A PEM pasted into a one-line CI secret keeps its newlines as \n.
            key.value.includes("\n")
              ? key.value
              : key.value.replaceAll("\\n", "\n"),
          ),
    keyId: keyId.value,
    issuerId: issuerId.value,
  }),
  "android-keystore": async (
    [keystore, storePassword, keyAlias, keyPassword],
    { files, name },
  ) => {
    let storeFile: string;
    if (keystore.name === "HOT_UPDATER_ANDROID_KEYSTORE_PATH") {
      storeFile = await readFileField("android-keystore", keystore);
    } else {
      registerSecretValue(keystore.value);
      const base64 = keystore.value.replace(/\s/g, "");
      const contents = Buffer.from(base64, "base64");
      if (
        contents.length === 0 ||
        contents.toString("base64").replace(/=+$/, "") !==
          base64.replace(/=+$/, "")
      ) {
        throw new CredentialUnavailableError(
          "android-keystore",
          `${keystore.name} is not a base64-encoded keystore.`,
        );
      }
      storeFile = await files.write(`${name}.keystore`, contents);
    }
    return {
      storeFile,
      storePassword: storePassword.value,
      keyAlias: keyAlias.value,
      keyPassword: keyPassword.value,
    };
  },
  "play-service-account": async ([serviceAccount]) => {
    const json =
      serviceAccount.name === "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH"
        ? await fs.readFile(
            await readFileField("play-service-account", serviceAccount),
            "utf-8",
          )
        : serviceAccount.value;
    const parsed = parseServiceAccount(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialUnavailableError(
        "play-service-account",
        `${serviceAccount.name} is not a service account JSON object.`,
      );
    }
    return { json };
  },
};

const CREDENTIAL_FIELDS = {
  "asc-api-key": ["keyPath", "keyId", "issuerId"],
  "android-keystore": ["storeFile", "storePassword", "keyAlias", "keyPassword"],
  "play-service-account": ["json"],
} as const satisfies {
  readonly [TKind in CredentialKind]: readonly (keyof Credentials[TKind])[];
};

const readSourcedCredential = <TKind extends CredentialKind>(
  kind: TKind,
  sourced: SourcedCredential,
): Credentials[TKind] => {
  const credential: Readonly<Record<string, unknown>> = sourced.credential;
  const fields: readonly string[] = CREDENTIAL_FIELDS[kind];
  if (
    sourced.kind !== kind ||
    !fields.every(
      (field) => typeof credential[field] === "string" && credential[field],
    )
  ) {
    throw new Error(`The credential source returned no valid ${kind}.`);
  }
  return sourced.credential as Credentials[TKind];
};

const registerCredentialSecrets = <TKind extends CredentialKind>(
  kind: TKind,
  credential: Credentials[TKind],
) => {
  if (kind === "android-keystore") {
    const keystore = credential as Credentials["android-keystore"];
    registerSecretValue(keystore.storePassword);
    registerSecretValue(keystore.keyPassword);
  }
  if (kind === "play-service-account") {
    const { json } = credential as Credentials["play-service-account"];
    registerSecretValue(json);
    const privateKey = (
      parseServiceAccount(json) as { private_key?: unknown } | undefined
    )?.private_key;
    if (typeof privateKey === "string") {
      registerSecretValue(privateKey);
    }
  }
};

export interface CreateCredentialResolverOptions {
  /**
   * Environment values read after `process.env`, the same lookup as
   * `getHotUpdaterEnvValue`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Where to find an item no environment override sets. Defaults to the
   * Console's vault, which `HOT_UPDATER_CONSOLE_URL` and
   * `HOT_UPDATER_VAULT_TOKEN` connect to.
   */
  readonly source?: CredentialSource;
}

/**
 * Resolves each item from its environment overrides when any is set, and
 * otherwise from `source`, the Console's vault by default, so overrides
 * never reach the vault. When the source fails, such as when the Console is
 * not reached, the error names the environment variables that can provide
 * the item instead. Nothing is cached, values are never written to disk
 * except as 0600 temporary files, and every secret is masked in logs.
 */
export const createCredentialResolver = ({
  env = {},
  source = createVaultCredentialSource({ env }),
}: CreateCredentialResolverOptions = {}): CredentialResolver => {
  const files = createCredentialFiles();
  const resolved = new Map<string, Promise<unknown>>();
  let disposal: Promise<void> | undefined;

  const resolveItem = async <TKind extends CredentialKind>(
    kind: TKind,
    name: string,
  ): Promise<Credentials[TKind]> => {
    const fields: readonly EnvField[] = CREDENTIAL_ENV_NAMES[kind];
    const values = fields.map((field) => readEnvField(env, field));

    if (values.some((value) => value !== undefined)) {
      const missing = fields.filter((_, index) => !values[index]);
      if (missing.length > 0) {
        throw new CredentialUnavailableError(
          kind,
          `The environment overrides ${kind} but ${describeFields(missing)} ${missing.length === 1 ? "is" : "are"} not set.`,
        );
      }
      const credential = await fromEnv[kind](values as EnvValue[], {
        files,
        name,
      });
      registerCredentialSecrets(kind, credential);
      return credential;
    }

    let credential: Credentials[TKind];
    try {
      credential = readSourcedCredential(
        kind,
        await source({ kind, name }, { files }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CredentialUnavailableError(
        kind,
        `${reason} ${credentialOverrideHint(kind)}`,
        { cause: error },
      );
    }
    registerCredentialSecrets(kind, credential);
    return credential;
  };

  return {
    resolve: <TKind extends CredentialKind>({
      kind,
      name = kind,
    }: CredentialRequest<TKind>) => {
      if (disposal) {
        return Promise.reject(
          new Error("The credential resolver has been disposed."),
        );
      }
      const key = `${kind}\u0000${name}`;
      let pending = resolved.get(key) as
        | Promise<Credentials[TKind]>
        | undefined;
      if (!pending) {
        pending = resolveItem(kind, name);
        resolved.set(key, pending);
        pending.catch(() => resolved.delete(key));
      }
      return pending;
    },
    dispose: () => {
      disposal ??= (async () => {
        // A resolution in flight may still write a file.
        await Promise.allSettled(resolved.values());
        resolved.clear();
        await files.dispose();
      })();
      return disposal;
    },
  };
};

/**
 * Runs `run` with a credential resolver and deletes its temporary files
 * when `run` settles.
 */
export const withCredentialResolver = async <T>(
  run: (resolver: CredentialResolver) => Promise<T>,
  options?: CreateCredentialResolverOptions,
): Promise<T> => {
  const resolver = createCredentialResolver(options);
  try {
    return await run(resolver);
  } finally {
    await resolver.dispose();
  }
};

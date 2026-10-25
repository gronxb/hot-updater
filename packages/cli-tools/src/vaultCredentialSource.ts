import {
  parseVaultSecretValue,
  type VaultSecretValues,
} from "@hot-updater/server/plugins";

import type { CredentialSource, SourcedCredential } from "./credentialResolver";
import { registerSecretValue } from "./secretMasking";
import {
  createVaultClient,
  resolveVaultConnection,
  type ResolvedVaultSecret,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  VaultRequestError,
} from "./vaultClient";

/** A secret the vault does not have, under a name the token may read. */
export class VaultSecretNotFoundError extends Error {
  readonly secretName: string;
  readonly url: string;

  constructor(url: string, name: string) {
    super(`The vault at ${url} has no secret ${name}.`);
    this.name = "VaultSecretNotFoundError";
    this.secretName = name;
    this.url = url;
  }
}

/**
 * Loads vault secrets by name, sending the names asked for in one turn of
 * the event loop, such as a build's credentials, in one resolve request.
 * Nothing is cached: each load reaches the Console.
 */
export const createVaultSecretLoader = (
  client: Pick<VaultClient, "resolve" | "url">,
) => {
  type Waiter = {
    readonly resolve: (secret: ResolvedVaultSecret) => void;
    readonly reject: (error: unknown) => void;
  };
  let batch: Map<string, Waiter[]> | undefined;

  const flush = async (names: Map<string, Waiter[]>) => {
    try {
      const { secrets } = await client.resolve([...names.keys()]);
      const byName = new Map(secrets.map((secret) => [secret.name, secret]));
      for (const [name, waiters] of names) {
        const secret = byName.get(name);
        for (const waiter of waiters) {
          if (secret) waiter.resolve(secret);
          else {
            waiter.reject(new VaultSecretNotFoundError(client.url, name));
          }
        }
      }
    } catch (error) {
      for (const waiters of names.values()) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
  };

  return (name: string): Promise<ResolvedVaultSecret> =>
    new Promise((resolve, reject) => {
      if (batch === undefined) {
        const names = new Map<string, Waiter[]>();
        batch = names;
        setTimeout(() => {
          batch = undefined;
          void flush(names);
        }, 0);
      }
      const waiters = batch.get(name) ?? [];
      waiters.push({ resolve, reject });
      batch.set(name, waiters);
    });
};

/** A kind with its article, such as "an asc-api-key". */
const aKind = (kind: string) =>
  `${/^[aeiou]/u.test(kind) ? "an" : "a"} ${kind}`;

/** The base64 file of a vault value's field, as bytes. */
const fileOf = (value: string): Buffer => Buffer.from(value, "base64");

/** A resolved secret's value in its kind's shape, or a thrown error naming it. */
const valueOf = <
  TKind extends "asc-api-key" | "android-keystore" | "play-service-account",
>(
  secret: ResolvedVaultSecret,
  kind: TKind,
): VaultSecretValues[TKind] => {
  try {
    return parseVaultSecretValue(kind, secret.value);
  } catch (error) {
    throw new Error(
      `The vault's ${secret.name} is not a valid ${kind}: ${(error as Error).message} Store it again in the Console or with hot-updater secrets put.`,
    );
  }
};

/**
 * The credential a resolved vault secret holds, its files written with
 * `files`. Every value it carries is masked in logs; ids and aliases, which
 * the Console lists as metadata, are not.
 */
const toCredential = async (
  secret: ResolvedVaultSecret,
  files: Parameters<CredentialSource>[1]["files"],
): Promise<SourcedCredential> => {
  switch (secret.kind) {
    case "asc-api-key": {
      const { p8, keyId, issuerId } = valueOf(secret, "asc-api-key");
      registerSecretValue(p8);
      return {
        kind: "asc-api-key",
        credential: {
          keyPath: await files.write(
            `AuthKey_${keyId}.p8`,
            fileOf(p8).toString("utf-8"),
          ),
          keyId,
          issuerId,
        },
      };
    }
    case "android-keystore": {
      const { keystore, storePassword, keyAlias, keyPassword } = valueOf(
        secret,
        "android-keystore",
      );
      registerSecretValue(keystore);
      return {
        kind: "android-keystore",
        credential: {
          storeFile: await files.write(
            `${secret.name}.keystore`,
            fileOf(keystore),
          ),
          storePassword,
          keyAlias,
          keyPassword,
        },
      };
    }
    case "play-service-account": {
      const { serviceAccount } = valueOf(secret, "play-service-account");
      registerSecretValue(serviceAccount);
      return {
        kind: "play-service-account",
        credential: { json: fileOf(serviceAccount).toString("utf-8") },
      };
    }
    default:
      throw new Error(
        `The vault's ${secret.name} is ${aKind(secret.kind)}, which is no build credential.`,
      );
  }
};

/** The build credentials the vault holds for the CLI. */
type BuildCredentialKind =
  | "asc-api-key"
  | "android-keystore"
  | "play-service-account";

/**
 * The command that stores a build credential of `kind` as the vault's
 * `name`, from the files a developer has or with a sign-in Hot Updater
 * issues the credential after: run once on a machine that reaches the
 * Console, so CI only reads it.
 */
export const vaultCredentialPutCommand = (
  kind: BuildCredentialKind,
  name: string = kind,
): string => {
  const put = `npx hot-updater secrets put ${name} --kind ${kind}`;
  switch (kind) {
    case "android-keystore":
      return `${put} --keystore <release.jks> --key-alias <alias>`;
    case "asc-api-key":
    // Signs in with an Apple Account, and Hot Updater issues the key.
    case "play-service-account":
      // Signs in with Google, and Hot Updater issues the key.
      return put;
  }
};

/**
 * What to do when the vault can't give a build `name`: store it once, or,
 * when the token's scope does not reach it, issue a token that may read it.
 */
const describeUnavailable = (
  kind: BuildCredentialKind,
  name: string,
  error: unknown,
): unknown => {
  const item = name === kind ? kind : `${name} (${kind})`;
  if (error instanceof VaultSecretNotFoundError) {
    return new Error(
      `${item} is not in the vault at ${error.url}. Store it once from a machine that reaches the Console, with \`${vaultCredentialPutCommand(kind, name)}\`, and builds, CI's included, read it with their vault token.`,
      { cause: error },
    );
  }
  if (error instanceof VaultRequestError && error.status === 403) {
    return new Error(
      `${error.message} When ${item} is stored, give the build a vault token whose scope allows read on it, such as one from \`npx hot-updater secrets token create --name ci-native --secrets ${name},<the build's other secrets> --actions read\`; when it is not, store it once with \`${vaultCredentialPutCommand(kind, name)}\`.`,
      { cause: error },
    );
  }
  return error;
};

/**
 * The Console's vault as a credential source, connected by
 * `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN`, read on the first
 * item it resolves. Items requested together go in one resolve request.
 */
export const createVaultCredentialSource = ({
  env = {},
  fetch,
}: {
  readonly env?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
} = {}): CredentialSource => {
  let load: ReturnType<typeof createVaultSecretLoader> | undefined;
  // One read for the items a build asks for together, so they still share
  // one resolve request.
  let connecting: ReturnType<typeof resolveVaultConnection> | undefined;

  return async ({ kind, name }, { files }) => {
    const read = await (connecting ??= resolveVaultConnection({ env }));
    if (!read.ok) {
      const item = name === kind ? kind : `${kind} ${name}`;
      throw new Error(
        `${item} resolves from the Console's vault, and ${read.missing.join(" and ")} ${read.missing.length === 1 ? "is" : "are"} not set in the environment or .env.hotupdater. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} to reach the vault.`,
      );
    }
    load ??= createVaultSecretLoader(
      createVaultClient({
        ...read.connection,
        ...(fetch === undefined ? {} : { fetch }),
      }),
    );
    const secret = await load(name).catch((error: unknown) => {
      throw describeUnavailable(kind, name, error);
    });
    if (secret.kind !== kind) {
      throw new Error(
        `The vault's ${name} is ${aKind(secret.kind)}, not ${aKind(kind)}.`,
      );
    }
    return toCredential(secret, files);
  };
};

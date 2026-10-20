import type { CredentialSource, SourcedCredential } from "./credentialResolver";
import { registerSecretValue } from "./secretMasking";
import {
  createVaultClient,
  readVaultConnection,
  type ResolvedVaultSecret,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
} from "./vaultClient";

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
            waiter.reject(
              new Error(`The vault at ${client.url} has no secret ${name}.`),
            );
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

/** The field of a vault value, a non-empty string, or a thrown error. */
const fieldOf = (secret: ResolvedVaultSecret, field: string): string => {
  const value =
    typeof secret.value === "object" && secret.value !== null
      ? (secret.value as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `The vault's ${secret.name} has no ${field}: store it again in the Console or with hot-updater secrets put.`,
    );
  }
  return value;
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
      const p8 = fieldOf(secret, "p8");
      const keyId = fieldOf(secret, "keyId");
      registerSecretValue(p8);
      return {
        kind: "asc-api-key",
        credential: {
          keyPath: await files.write(
            `AuthKey_${keyId}.p8`,
            fileOf(p8).toString("utf-8"),
          ),
          keyId,
          issuerId: fieldOf(secret, "issuerId"),
        },
      };
    }
    case "android-keystore": {
      const keystore = fieldOf(secret, "keystore");
      registerSecretValue(keystore);
      return {
        kind: "android-keystore",
        credential: {
          storeFile: await files.write(
            `${secret.name}.keystore`,
            fileOf(keystore),
          ),
          storePassword: fieldOf(secret, "storePassword"),
          keyAlias: fieldOf(secret, "keyAlias"),
          keyPassword: fieldOf(secret, "keyPassword"),
        },
      };
    }
    case "play-service-account": {
      const serviceAccount = fieldOf(secret, "serviceAccount");
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

  return async ({ kind, name }, { files }) => {
    if (load === undefined) {
      const read = readVaultConnection(env);
      if (!read.ok) {
        const item = name === kind ? kind : `${kind} ${name}`;
        throw new Error(
          `${item} resolves from the Console's vault, and ${read.missing.join(" and ")} ${read.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} to reach the vault.`,
        );
      }
      load = createVaultSecretLoader(
        createVaultClient({
          ...read.connection,
          ...(fetch === undefined ? {} : { fetch }),
        }),
      );
    }
    const secret = await load(name);
    if (secret.kind !== kind) {
      throw new Error(
        `The vault's ${name} is ${aKind(secret.kind)}, not ${aKind(kind)}.`,
      );
    }
    return toCredential(secret, files);
  };
};

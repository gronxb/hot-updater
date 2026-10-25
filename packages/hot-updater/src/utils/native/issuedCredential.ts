import {
  CREDENTIAL_ENV_NAMES,
  createVaultClient,
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
  getCwd,
  resolveVaultConnection,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  VaultRequestError,
  type VaultSecretMetadata,
} from "@hot-updater/cli-tools";

import { canPrompt } from "../prompt";

/**
 * The vault secrets Hot Updater issues itself after a sign-in, when a build
 * needs one and the vault has none: an App Store Connect API key after an
 * Apple Account sign-in, a Play service account after a Google one.
 */
export type IssuedCredentialKind = "asc-api-key" | "play-service-account";

/** The command that signs in once, in a terminal, and stores the key. */
export const credentialSetupCommand = (
  name: string,
  kind: IssuedCredentialKind,
) => `npx hot-updater secrets put ${name} --kind ${kind}`;

/**
 * Why there is no key to sign or upload with: there is no terminal to sign
 * in in, which `canPrompt` already reported, setting the exit code, or the
 * developer cancelled a prompt.
 */
export class CredentialSetupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialSetupRefusedError";
  }
}

/** How one kind of issued key is described in the preflight's messages. */
export interface IssuedCredentialPolicy {
  readonly kind: IssuedCredentialKind;
  /** The key, such as "an App Store Connect API key". */
  readonly what: string;
  /** Who the developer signs in with, such as "your Apple Account". */
  readonly signIn: string;
  /** What to do about a secret of another kind under the key's name. */
  readonly otherKindFix: (name: string) => string;
}

export type PreparedCredential =
  /** The environment overrides the key: nothing is looked up in the vault. */
  | { readonly status: "environment" }
  /** The vault holds the key already: no sign-in. */
  | { readonly status: "stored"; readonly version: number }
  /**
   * The vault has no key, and everything a sign-in needs holds: a terminal,
   * and a vault token that may store it. `env` is the environment with the
   * project's `.env.hotupdater` under it.
   */
  | {
      readonly status: "missing";
      readonly client: VaultClient;
      readonly env: Readonly<Record<string, string>>;
    };

const aKind = (kind: string) =>
  `${/^[aeiou]/u.test(kind) ? "an" : "a"} ${kind}`;

/**
 * Whether the vault token may write `name` as `kind`, asked without storing
 * anything: the Console checks a write's scope, by name or by kind, before
 * its value, so a write of an empty value is refused with 400 when the token
 * may write it and 403 when it may not. A 403 is logged as a denied write.
 * Read is not asked: before the secret exists, the Console refuses it to a
 * token scoped by kind, which may read it once stored.
 */
const assertWritable = async (
  client: VaultClient,
  name: string,
  policy: IssuedCredentialPolicy,
) => {
  try {
    await client.put({
      name,
      kind: policy.kind,
      value: {},
      expectedVersion: 0,
    });
  } catch (error) {
    if (!(error instanceof VaultRequestError)) throw error;
    if (error.status === 400 && error.code === "invalid_request") return;
    if (error.status === 403) {
      throw new Error(
        `The vault token cannot store ${name}, which keeps the key Hot Updater issues after you sign in with ${policy.signIn}. Use a vault token whose scope allows write on ${name} (hot-updater secrets token create --actions read,write), so you sign in only once.`,
        { cause: error },
      );
    }
    if (error.status === 404 || error.status === 405) {
      throw new Error(
        `The Console at ${client.url} does not store secrets from the CLI: upgrade it, then run this again.`,
        { cause: error },
      );
    }
    throw error;
  }
  // The Console never stores an empty value; reaching here means it did.
  throw new Error(
    `The Console at ${client.url} accepted an empty ${name}: remove it in the Console, then run this again.`,
  );
};

/**
 * Everything checked before a sign-in, in this order, so nothing fails
 * after the developer signed in but storage:
 *
 * 1. an environment override of the kind is used as it is (unless
 *    `environment` is false, as `secrets put` stores in the vault anyway);
 * 2. a vault secret named `name` of the kind is used as it is, so CI builds
 *    with the stored key and never signs in;
 * 3. without a terminal, it refuses with the command that signs in once;
 * 4. the vault token must be allowed to store `name`.
 *
 * The vault connection is read as every command reads it: the environment,
 * then `env`, then the project's `.env.hotupdater`. The vault is the only
 * place an issued key is stored: environment overrides are read, never
 * written.
 */
export const prepareIssuedCredential = async (
  policy: IssuedCredentialPolicy,
  {
    name,
    env = {},
    environment = true,
  }: {
    readonly name: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly environment?: boolean;
  },
): Promise<PreparedCredential> => {
  const fields = CREDENTIAL_ENV_NAMES[policy.kind];
  if (
    environment &&
    fields
      .flat()
      .some((variable) => getHotUpdaterEnvValue(env, variable) !== undefined)
  ) {
    return { status: "environment" };
  }

  const connection = await resolveVaultConnection({ env });
  if (!connection.ok) {
    throw new Error(
      `${name} is ${policy.what}, which Hot Updater issues when you sign in with ${policy.signIn} and keeps in the Console's vault, and ${connection.missing.join(" and ")} ${connection.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} (a token that may write ${name}), or set ${fields.map((field) => field.join(" or ")).join(", ")} to use a key you already have.`,
    );
  }
  const client = createVaultClient(connection.connection);
  const existing = (await client.list()).find((secret) => secret.name === name);
  if (existing?.kind === policy.kind) {
    return { status: "stored", version: existing.version };
  }
  if (existing) {
    throw new Error(
      `The vault's ${name} is ${aKind(existing.kind)}, not ${aKind(policy.kind)}: ${policy.otherKindFix(name)}`,
    );
  }

  if (
    !canPrompt(
      `${name} is not in the vault yet. Hot Updater issues it when you sign in with ${policy.signIn}, which needs a terminal.`,
      `Run \`${credentialSetupCommand(name, policy.kind)}\` in a terminal once, and builds use the stored key, also`,
    )
  ) {
    throw new CredentialSetupRefusedError(
      `${name} is not in the vault, and there is no terminal to sign in with ${policy.signIn}.`,
    );
  }

  await assertWritable(client, name, policy);
  return {
    status: "missing",
    client,
    env: { ...(await readLoadedHotUpdaterEnv(getCwd())), ...env },
  };
};

/** The vault surely does not hold the issued key: the caller revokes it. */
export class CredentialNotStoredError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "CredentialNotStoredError";
  }
}

/**
 * The vault may hold the issued key, which nothing confirmed: the caller
 * keeps the key, since revoking one the vault holds leaves it a dead key.
 */
export class CredentialStoreUnconfirmedError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "CredentialStoreUnconfirmedError";
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether the Console answered a write, and so stored nothing: an
 * unanswered write or a server error may have stored it, but a locked vault
 * (503) never does.
 */
const refusedWrite = (error: unknown) =>
  error instanceof VaultRequestError &&
  error.status !== undefined &&
  (error.status < 500 || error.status === 503);

/**
 * Stores an issued key as `name`, never over a key someone stored
 * meanwhile, and reads it back: the vault must list `name` as the key just
 * issued, which `isIssued` recognizes by its metadata. Returns the version.
 * Throws `CredentialNotStoredError` when the vault surely does not hold it,
 * and `CredentialStoreUnconfirmedError` when nothing tells.
 */
export const storeIssuedCredential = async ({
  client,
  name,
  kind,
  value,
  isIssued,
}: {
  readonly client: VaultClient;
  readonly name: string;
  readonly kind: IssuedCredentialKind;
  readonly value: Readonly<Record<string, string>>;
  readonly isIssued: (listed: VaultSecretMetadata) => boolean;
}): Promise<number> => {
  /** The vault's `name` when it is the key just issued, from a fresh list. */
  const listIssued = async () => {
    const listed = (await client.list()).find(
      (candidate) => candidate.name === name,
    );
    return listed?.kind === kind && isIssued(listed) ? listed : undefined;
  };

  let version: number;
  try {
    version = (await client.put({ name, kind, value, expectedVersion: 0 }))
      .version;
  } catch (error) {
    if (refusedWrite(error)) {
      throw new CredentialNotStoredError(errorText(error), { cause: error });
    }
    // The write may have landed: the vault's list tells.
    let held: Awaited<ReturnType<typeof listIssued>>;
    try {
      held = await listIssued();
    } catch {
      throw new CredentialStoreUnconfirmedError(errorText(error), {
        cause: error,
      });
    }
    if (held === undefined) {
      throw new CredentialNotStoredError(errorText(error), { cause: error });
    }
    return held.version;
  }

  let held: Awaited<ReturnType<typeof listIssued>>;
  try {
    held = await listIssued();
  } catch (error) {
    throw new CredentialStoreUnconfirmedError(errorText(error), {
      cause: error,
    });
  }
  if (held?.version !== version) {
    throw new CredentialNotStoredError(
      "the vault does not list it as the key just stored.",
    );
  }
  return version;
};

/**
 * Whether the vault token reads `name` back at `version`, as the build
 * resolves it. Asked after the store: before it, the Console refuses a name
 * no secret has to a token scoped by kind, which may read it once stored.
 * The key stays stored either way, so the next run does not sign in.
 */
export const assertReadableCredential = async ({
  client,
  name,
  kind,
  version,
  usage,
}: {
  readonly client: VaultClient;
  readonly name: string;
  readonly kind: IssuedCredentialKind;
  readonly version: number;
  /** What reads it, such as "the build uploads with". */
  readonly usage: string;
}) => {
  try {
    const { secrets } = await client.resolve([name]);
    if (
      secrets.some(
        (secret) =>
          secret.name === name &&
          secret.kind === kind &&
          secret.version === version,
      )
    ) {
      return;
    }
  } catch (error) {
    if (!(error instanceof VaultRequestError && error.status === 403)) {
      throw error;
    }
  }
  throw new Error(
    `${name} is stored (v${version}), but the vault token cannot read it, which ${usage}. Use a vault token whose scope allows read on ${name}, then run the build again: it uses the stored key without signing in.`,
  );
};

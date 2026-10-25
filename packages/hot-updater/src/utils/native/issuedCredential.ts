import {
  CREDENTIAL_ENV_NAMES,
  credentialPutCommand,
  describeSecret,
  getConfiguredSecrets,
  getCwd,
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { canSignIn } from "../prompt";

/**
 * The credentials Hot Updater issues itself after a sign-in, when a build
 * needs one and the config's `secrets` adapter has none: an App Store
 * Connect API key after an Apple Account sign-in, a Play service account
 * after a Google one.
 */
export type IssuedCredentialKind = "asc-api-key" | "play-service-account";

/** The command that signs in once, at a terminal, and stores the key. */
export const credentialSetupCommand = (
  name: string,
  kind: IssuedCredentialKind,
) => credentialPutCommand(kind, name);

/**
 * Why there is no key to sign or upload with: the run is in CI or has no
 * terminal to sign in at, which `canSignIn` already reported, setting the
 * exit code, or the developer cancelled a prompt.
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
  /** The account `canSignIn` names, such as "Apple Account". */
  readonly account: string;
}

/** A secrets adapter that stores values. */
export type WritableSecrets = SecretsAdapter &
  Required<Pick<SecretsAdapter, "set">>;

export type PreparedCredential =
  /** The environment overrides the key: the adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter holds the key already: no sign-in. */
  | { readonly status: "stored" }
  /**
   * The adapter has no key, and everything a sign-in needs holds: a
   * terminal, and an adapter that stores values. `env` is the environment
   * with the project's `.env.hotupdater` under it.
   */
  | {
      readonly status: "missing";
      readonly secrets: WritableSecrets;
      readonly env: Readonly<Record<string, string>>;
    };

/** What the adapter's `name` holds, or why it can't be read, for messages. */
const describeUnavailable = (
  secrets: SecretsAdapter,
  name: string,
  kind: IssuedCredentialKind,
) => {
  const item = name === kind ? kind : `${name} (${kind})`;
  return `${item} is not in the ${secrets.name} secrets adapter (${describeSecret(secrets, name)}). Store it once from a terminal with \`${credentialSetupCommand(name, kind)}\`, which signs in and stores the key Hot Updater issues, and builds, CI's included, read it from there.`;
};

/**
 * Everything checked before a sign-in, in this order, so nothing fails
 * after the developer signed in but storage:
 *
 * 1. an environment override of the kind is used as it is (unless
 *    `environment` is false, as `secrets put` stores in the adapter anyway);
 * 2. a value the config's `secrets` adapter holds as `name` is used as it
 *    is, so CI builds with the stored key and never signs in;
 * 3. in CI or without a terminal, `canSignIn` refuses with the command
 *    that signs in once;
 * 4. the adapter must store values (`set`).
 *
 * The environment overrides are read, never written.
 */
export const prepareIssuedCredential = async (
  policy: IssuedCredentialPolicy,
  {
    name,
    env = {},
    environment = true,
    secrets = getConfiguredSecrets(),
  }: {
    readonly name: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly environment?: boolean;
    /** The adapter the key is read from and stored in, the config's by default. */
    readonly secrets?: SecretsAdapter;
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

  const cwd = getCwd();
  const held = (await secrets.get([name], { cwd }))[name];
  if (typeof held === "string" && held) return { status: "stored" };

  if (
    !(await canSignIn({
      account: policy.account,
      kind: policy.kind,
      describeUnavailable: async () =>
        describeUnavailable(secrets, name, policy.kind),
    }))
  ) {
    throw new CredentialSetupRefusedError(
      `${name} is not in the ${secrets.name} secrets adapter, and there is no terminal to sign in with ${policy.signIn}.`,
    );
  }

  const { set } = secrets;
  if (set === undefined) {
    throw new Error(
      `${name} is ${policy.what}, which Hot Updater issues when you sign in with ${policy.signIn} and stores through the config's secrets adapter, and the ${secrets.name} secrets adapter is read-only. Configure a secrets adapter that stores values, or set ${fields.map((field) => field.join(" or ")).join(", ")} to use a key you already have.`,
    );
  }
  return {
    status: "missing",
    secrets: { ...secrets, set },
    env: { ...(await readLoadedHotUpdaterEnv(cwd)), ...env },
  };
};

/** The adapter surely does not hold the issued key: the caller revokes it. */
export class CredentialNotStoredError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "CredentialNotStoredError";
  }
}

/**
 * The adapter may hold the issued key, which nothing confirmed: the caller
 * keeps the key, since revoking one the adapter holds leaves it a dead key.
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
 * Stores an issued key's `value` as `name`, and reads it back: returns
 * whether the adapter reads it as stored, which a write-only store does
 * not. Throws `CredentialNotStoredError` only when the write failed and
 * the adapter reads back no such value, so the caller may revoke the key,
 * and `CredentialStoreUnconfirmedError` when nothing tells, or the adapter
 * reads back another value: a key the store may hold is never revoked.
 */
export const storeIssuedCredential = async ({
  secrets,
  name,
  value,
}: {
  readonly secrets: WritableSecrets;
  readonly name: string;
  readonly value: string;
}): Promise<{ readonly readable: boolean }> => {
  const cwd = getCwd();
  const readBack = async () => (await secrets.get([name], { cwd }))[name];

  try {
    await secrets.set(name, value, { cwd });
  } catch (error) {
    // The write may have landed: a read tells.
    let held: string | undefined;
    try {
      held = await readBack();
    } catch {
      throw new CredentialStoreUnconfirmedError(errorText(error), {
        cause: error,
      });
    }
    if (held === value) return { readable: true };
    if (held === undefined) {
      throw new CredentialNotStoredError(errorText(error), { cause: error });
    }
    throw new CredentialStoreUnconfirmedError(errorText(error), {
      cause: error,
    });
  }

  const held = await readBack().catch(() => undefined);
  if (held !== undefined && held !== value) {
    throw new CredentialStoreUnconfirmedError(
      `the ${secrets.name} secrets adapter stored ${name}, and reads back another value.`,
    );
  }
  return { readable: held === value };
};

/**
 * The build resolves `name` right after it is issued: the adapter must read
 * back what it stored. The key stays stored either way, so the next run does
 * not sign in.
 */
export const assertReadableCredential = ({
  secrets,
  name,
  readable,
  usage,
}: {
  readonly secrets: SecretsAdapter;
  readonly name: string;
  readonly readable: boolean;
  /** What reads it, such as "the build uploads with". */
  readonly usage: string;
}) => {
  if (readable) return;
  throw new Error(
    `${name} is stored, but the ${secrets.name} secrets adapter does not read it back, which ${usage}. Make ${describeSecret(secrets, name)} readable where the build runs, then run it again: it uses the stored key without signing in.`,
  );
};

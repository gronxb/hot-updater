import {
  CREDENTIAL_ENV_NAMES,
  credentialLoginCommand,
  describeSecret,
  getConfiguredSecrets,
  getCwd,
  getHotUpdaterEnvValue,
  getLocalSecretsStore,
  type IssuedCredentialKind,
  keepsKeysOnThisMachine,
  p,
  readLoadedHotUpdaterEnv,
  readSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { ui } from "../cli-ui";
import { canSignIn } from "../prompt";
import { type CreateGitHubSecrets, offerGitHubSecret } from "./githubSecret";

export type { IssuedCredentialKind };

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
  /** Its name in headings, such as "App Store Connect API key". */
  readonly label: string;
  /** Who the developer signs in with, such as "your Apple Account". */
  readonly signIn: string;
  /** The account `canSignIn` names, such as "Apple Account". */
  readonly account: string;
}

export type PreparedCredential =
  /** The environment overrides the key: the adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter holds the key: no sign-in. */
  | { readonly status: "stored" }
  /**
   * Nothing holds the key, and a sign-in can start: there is a terminal.
   * The key goes to `secrets`, the config's adapter or `localSecrets()`.
   * `env` is the environment with the project's `.env.hotupdater` under it.
   */
  | {
      readonly status: "missing";
      readonly secrets: SecretsAdapter;
      readonly env: Readonly<Record<string, string>>;
    };

/** That the adapter lacks `name`, and the command that stores it once. */
const describeUnavailable = (
  secrets: SecretsAdapter,
  name: string,
  kind: IssuedCredentialKind,
) => ({
  missing: `${name === kind ? kind : `${name} (${kind})`} is not in the ${secrets.name} secrets adapter.`,
  fix: ui.withCommand(
    "Run once in a terminal:",
    credentialLoginCommand(kind, name),
  ),
});

/**
 * Everything checked before a sign-in, in this order, so nothing fails
 * after the developer signed in:
 *
 * 1. an environment override of the kind is used as it is;
 * 2. a value the config's `secrets` adapter holds as `name` is used as it
 *    is, so CI builds with the stored key and never signs in, unless
 *    `replace` is set: `secrets issue` read it already;
 * 3. in CI or without a terminal, `canSignIn` refuses with the command
 *    that signs in once;
 * 4. when nothing holds a key and the key would stay on this machine, the
 *    developer is told that signing in issues a new key, and how to share
 *    one instead.
 *
 * The environment overrides are read, never written.
 */
export const prepareIssuedCredential = async (
  policy: IssuedCredentialPolicy,
  {
    name,
    env = {},
    replace = false,
    replacing = false,
    secrets = getConfiguredSecrets(),
  }: {
    readonly name: string;
    readonly env?: Readonly<Record<string, string>>;
    /**
     * Set by `secrets issue`, which read the adapter itself and issues a
     * key whatever it holds: the adapter is not read again.
     */
    readonly replace?: boolean;
    /** Set by `secrets issue --replace` when the adapter holds a key it replaces. */
    readonly replacing?: boolean;
    /** The adapter the key is read from and stored in, the config's by default. */
    readonly secrets?: SecretsAdapter;
  },
): Promise<PreparedCredential> => {
  const fields = CREDENTIAL_ENV_NAMES[policy.kind];
  if (
    fields
      .flat()
      .some((variable) => getHotUpdaterEnvValue(env, variable) !== undefined)
  ) {
    return { status: "environment" };
  }

  const cwd = getCwd();
  if (!replace) {
    const held = (await readSecrets(secrets, [name], cwd))[name];
    if (typeof held === "string" && held) return { status: "stored" };
  }

  if (
    !(await canSignIn({
      account: policy.account,
      describeUnavailable: async () =>
        describeUnavailable(secrets, name, policy.kind),
    }))
  ) {
    throw new CredentialSetupRefusedError(
      `${name} is not in the ${secrets.name} secrets adapter, and there is no terminal to sign in to ${policy.signIn}.`,
    );
  }

  if (!replacing && keepsKeysOnThisMachine(secrets)) {
    p.log.info(`No ${policy.label} on this machine: signing in issues one.`);
  }
  return {
    status: "missing",
    secrets,
    env: { ...(await readLoadedHotUpdaterEnv(cwd)), ...env },
  };
};

/**
 * A secrets adapter that reads `name` with `read` and every other name
 * from `secrets`, so the run that issued the key signs and uploads with it
 * from memory. `where` names it in messages.
 */
export const withIssuedKey = (
  secrets: SecretsAdapter,
  name: string,
  read: () => Promise<string>,
  where: string,
): SecretsAdapter => ({
  name: secrets.name,
  get: async (names, context) => {
    const others = names.filter((other) => other !== name);
    const values: Record<string, string | undefined> = Object.create(null);
    if (others.length > 0) {
      Object.assign(values, await secrets.get(others, context));
    }
    if (names.includes(name)) values[name] = await read();
    return values;
  },
  set: (other, value, context) => secrets.set(other, value, context),
  describe: (other) =>
    other === name ? where : describeSecret(secrets, other),
});

/**
 * After a key Hot Updater issued is stored in the default store, which
 * keeps it on this machine: offers once to store it as the GitHub Actions
 * secret CI reads it from, when the project has a GitHub remote and the
 * developer a token.
 */
export const offerIssuedKeyToGitHub = async ({
  name,
  value,
  secrets,
  githubSecrets,
}: {
  readonly name: string;
  readonly value: string;
  readonly secrets: SecretsAdapter;
  /** The adapter the GitHub Actions offer writes with. */
  readonly githubSecrets?: CreateGitHubSecrets;
}): Promise<void> => {
  // A key another adapter stores is read where it is.
  const store = getLocalSecretsStore(secrets);
  if (!store) return;
  await offerGitHubSecret({
    name,
    value,
    file: store.file(name, getCwd()),
    ...(githubSecrets ? { createSecrets: githubSecrets } : {}),
  });
};

/**
 * The adapter does not hold the issued key as it was issued: the caller
 * revokes it.
 */
export class CredentialNotStoredError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "CredentialNotStoredError";
  }
}

/**
 * The adapter's write failed, and it may hold the issued key, which
 * nothing confirmed: the caller keeps the key, since revoking one the
 * adapter holds leaves it a dead key.
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
 * Stores an issued key's `value` as `name`, and reads it back through the
 * adapter, which must hold exactly `value`: a key it doesn't read back is
 * one no build, here or on a teammate's machine, finds. Throws
 * `CredentialNotStoredError`, so the caller revokes the key, when the
 * write succeeded and the read-back fails or differs, or when the write
 * failed and the adapter reads back no such value; and
 * `CredentialStoreUnconfirmedError` when the write failed and nothing
 * tells whether the adapter holds the key.
 */
export const storeIssuedCredential = async ({
  secrets,
  name,
  value,
}: {
  readonly secrets: SecretsAdapter;
  readonly name: string;
  readonly value: string;
}): Promise<void> => {
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
    if (held === value) return;
    if (held === undefined) {
      throw new CredentialNotStoredError(errorText(error), { cause: error });
    }
    throw new CredentialStoreUnconfirmedError(errorText(error), {
      cause: error,
    });
  }

  let held: string | undefined;
  try {
    held = await readBack();
  } catch (error) {
    throw new CredentialNotStoredError(
      `The ${secrets.name} secrets adapter can't read back ${name}: ${errorText(error)}`,
      { cause: error },
    );
  }
  if (held !== value) {
    throw new CredentialNotStoredError(
      `The ${secrets.name} secrets adapter reads back ${held === undefined ? "nothing" : "another value"} for ${name}.`,
    );
  }
};

/**
 * The adapter the rest of an issuing run reads with: the issued key from
 * memory, every other name from `secrets`. Nothing is written elsewhere.
 */
export const withIssuedValue = (
  secrets: SecretsAdapter,
  name: string,
  value: string,
): SecretsAdapter =>
  withIssuedKey(
    secrets,
    name,
    async () => value,
    describeSecret(secrets, name),
  );

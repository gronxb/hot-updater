import {
  CREDENTIAL_ENV_NAMES,
  credentialLoginCommand,
  describeSecret,
  getConfiguredAdapter,
  getConfiguredSecrets,
  getCwd,
  getHotUpdaterEnvValue,
  getLocalSecretsStore,
  type IssuedCredentialKind,
  keepsKeysOnThisMachine,
  p,
  readLoadedHotUpdaterEnv,
  registerCredentialValue,
  withLocalKeyStore,
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

/** A secrets adapter that stores values. */
export type WritableSecrets = SecretsAdapter &
  Required<Pick<SecretsAdapter, "set">>;

export type PreparedCredential =
  /** The environment overrides the key: the adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter, or `localSecrets()`'s store, holds the key: no sign-in. */
  | { readonly status: "stored" }
  /**
   * Nothing holds the key, and a sign-in can start: there is a terminal.
   * The key goes to `secrets`, the config's adapter with `localSecrets()`'s
   * store after it. `env` is the environment with the project's
   * `.env.hotupdater` under it.
   */
  | {
      readonly status: "missing";
      readonly secrets: WritableSecrets;
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
 * 2. a value the config's `secrets` adapter, or `localSecrets()`'s store,
 *    holds as `name` is used as it is, so CI builds with the stored key
 *    and never signs in, unless `replace` is set: `secrets issue` read it
 *    already;
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
    secrets: configured = getConfiguredSecrets(),
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

  const secrets = withLocalKeyStore(configured) as WritableSecrets;
  const cwd = getCwd();
  if (!replace) {
    const held = (await secrets.get([name], { cwd }))[name];
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
 * from `secrets`, so the build that issued the key signs and uploads with
 * it before builds read it where it is stored. `where` names it in messages.
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
  if (getConfiguredAdapter(secrets) !== undefined) return;
  await offerGitHubSecret({
    name,
    value,
    file: getLocalSecretsStore(secrets).file(name, getCwd()),
    ...(githubSecrets ? { createSecrets: githubSecrets } : {}),
  });
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

/** A file system error's code, such as `EACCES`, which names its path already. */
const fsErrorText = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : errorText(error);

/**
 * Stores an issued key's `value` as `name`, and reads it back: returns
 * whether the adapter reads it as stored, which a write-only store does
 * not. Throws `CredentialNotStoredError` only when the write failed and
 * the adapter reads back no such value, so the caller may revoke the key,
 * and `CredentialStoreUnconfirmedError` when nothing tells, or the adapter
 * reads back another value, such as the key it replaces from a store whose
 * latest version lags: a key the store may hold is never revoked.
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
  // An adapter that stores values is read back alone: localSecrets()'s copy
  // after it may hold the key this one replaces.
  const configured = getConfiguredAdapter(secrets);
  const reader = configured?.set ? configured : secrets;
  const readBack = async () => (await reader.get([name], { cwd }))[name];

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
      `It reads back another value for ${name}.`,
    );
  }
  return { readable: held === value };
};

/**
 * The adapter stored the issued key and does not read it back here, as a
 * write-only store does: builds on this machine would not find it, and the
 * key is printed nowhere. Keeps a copy in `localSecrets()`'s store, which builds
 * here read after the adapter, and returns the adapter this run
 * reads the key with: from the copy, or from memory when the copy can't be
 * written, which is reported. The key stays stored either way, and is
 * never revoked.
 */
export const keepIssuedCopy = async ({
  policy,
  name,
  value,
  secrets,
}: {
  readonly policy: IssuedCredentialPolicy;
  readonly name: string;
  readonly value: string;
  readonly secrets: SecretsAdapter;
}): Promise<SecretsAdapter> => {
  registerCredentialValue(value);
  const cwd = getCwd();
  const store = getLocalSecretsStore(secrets);
  let file: string;
  try {
    file = await store.write(name, value, cwd);
  } catch (error) {
    p.log.warn(
      [
        `Couldn't copy ${name} to ${ui.fitPath(store.file(name, cwd))}: ${fsErrorText(error)}`,
        `Only this build, and builds that read ${secrets.name}, use the key.`,
      ].join("\n"),
    );
    return withIssuedKey(
      secrets,
      name,
      async () => value,
      describeSecret(secrets, name),
    );
  }
  p.log.info(
    ui.summary(`${policy.label} copied to this machine`, [
      ["Source", ui.fitPath(file)],
    ]),
  );
  return withIssuedKey(
    secrets,
    name,
    async () => (await store.read(name, cwd)) ?? value,
    file,
  );
};

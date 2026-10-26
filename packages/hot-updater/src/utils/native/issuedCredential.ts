import fs from "node:fs/promises";
import path from "node:path";

import {
  CREDENTIAL_ENV_NAMES,
  credentialIssueCommand,
  describeSecret,
  envSecrets,
  getConfiguredSecrets,
  getCwd,
  getHotUpdaterEnvValue,
  type IssuedCredentialKind,
  p,
  readLoadedHotUpdaterEnv,
  registerCredentialValue,
  secretVariableName,
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

/**
 * `secrets issue` read the adapter itself, and issues a key whatever it
 * holds: the adapter is not read again before the sign-in. `previous` is
 * what it held as the name, the key the new one replaces, if any.
 */
export interface IssuedCredentialReplacement {
  readonly previous?: string;
}

/** A secrets adapter that stores values. */
export type WritableSecrets = SecretsAdapter &
  Required<Pick<SecretsAdapter, "set">>;

/** Where an issued key goes once the developer signed in. */
export type IssuedCredentialTarget =
  /**
   * The config's `secrets` adapter stores values: the key goes there, and
   * to `file` as well when the adapter does not read it back here.
   */
  | {
      readonly kind: "adapter";
      readonly secrets: WritableSecrets;
      readonly file: string;
    }
  /**
   * The adapter is read-only, such as `env()`: the key goes to `file`, a
   * 0600 file under `cacheDir`, and the developer is told where to store it.
   */
  | {
      readonly kind: "file";
      readonly secrets: SecretsAdapter;
      readonly file: string;
    };

export type PreparedCredential =
  /** The environment overrides the key: the adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter holds the key already: no sign-in. */
  | { readonly status: "stored" }
  /**
   * The adapter has no key, and everything a sign-in needs holds: a
   * terminal, and somewhere to keep the key. `env` is the environment
   * with the project's `.env.hotupdater` under it.
   */
  | {
      readonly status: "missing";
      readonly target: IssuedCredentialTarget;
      readonly env: Readonly<Record<string, string>>;
    };

/** The config's `cacheDir` when it sets none, or sets `null`. */
const DEFAULT_CACHE_DIR = path.join("node_modules", ".hot-updater");

/**
 * The file a key issued for a read-only adapter is written to,
 * `<cacheDir>/issued/<name>.json`. A secret's name has no path separator
 * and does not start with a dot.
 */
export const issuedCredentialFile = (
  name: string,
  cacheDir: string | null | undefined,
  cwd: string = getCwd(),
) =>
  path.join(
    path.resolve(cwd, cacheDir ?? DEFAULT_CACHE_DIR),
    "issued",
    `${name}.json`,
  );

/** No such file, or a path through something that is no directory. */
const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * A file left from an earlier sign-in holds a key that builds here do not
 * read yet: it is never replaced, which would lose that key while it stays
 * valid, and no other key is issued for it.
 */
const refuseEarlierFile = async (
  policy: IssuedCredentialPolicy,
  name: string,
  secrets: SecretsAdapter,
  file: string,
) => {
  const exists = await fs.lstat(file).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  if (!exists) return;
  throw new Error(
    [
      `${file} holds ${policy.what} Hot Updater issued earlier, which builds here do not read yet.`,
      ...(secrets.set === undefined
        ? [
            ...localGuidance(policy.kind, name, secrets, file),
            ciGuidance(name, secrets),
          ]
        : [fieldGuidance(policy.kind)]),
      "Or delete the file, and run this again to sign in and issue another.",
    ].join("\n"),
  );
};

/** Makes `file`'s directory, 0700 and ignored by git. */
const prepareIssuedDirectory = async (file: string) => {
  const directory = path.dirname(file);
  // Only `issued` is the CLI's to restrict: cacheDir keeps its own mode.
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode as it is.
  await fs.chmod(directory, 0o700);
  // A custom cacheDir may be in the repository: no issued key is committed.
  await fs.writeFile(path.join(directory, ".gitignore"), "*\n", {
    mode: 0o600,
  });
  await fs.access(directory, fs.constants.W_OK);
};

/**
 * Makes `file`'s directory before any sign-in, so the issued key's write
 * cannot fail on it.
 */
const prepareIssuedFile = async (
  policy: IssuedCredentialPolicy,
  name: string,
  secrets: SecretsAdapter,
  file: string,
) => {
  try {
    await prepareIssuedDirectory(file);
  } catch (error) {
    throw new Error(
      `${name} is ${policy.what}, which Hot Updater issues when you sign in with ${policy.signIn}, and the ${secrets.name} secrets adapter is read-only, so the key would be written to ${file}, whose directory Hot Updater can't write: ${error instanceof Error ? error.message : String(error)}. Set cacheDir in hot-updater.config.ts to a directory it can write, or set ${CREDENTIAL_ENV_NAMES[policy.kind].map((field) => field.join(" or ")).join(", ")} to use a key you already have.`,
      { cause: error },
    );
  }
};

/** What the adapter's `name` holds, or why it can't be read, for messages. */
const describeUnavailable = (
  secrets: SecretsAdapter,
  name: string,
  kind: IssuedCredentialKind,
) => {
  const item = name === kind ? kind : `${name} (${kind})`;
  return `${item} is not in the ${secrets.name} secrets adapter (${describeSecret(secrets, name)}). Store it once from a terminal with \`${credentialIssueCommand(kind, name)}\`, which signs in and stores the key Hot Updater issues, and builds, CI's included, read it from there.`;
};

/**
 * Everything checked before a sign-in, in this order, so nothing fails
 * after the developer signed in:
 *
 * 1. an environment override of the kind is used as it is;
 * 2. a value the config's `secrets` adapter holds as `name` is used as it
 *    is, so CI builds with the stored key and never signs in, unless
 *    `replace` is set: `secrets issue` read the adapter already;
 * 3. in CI or without a terminal, `canSignIn` refuses with the command
 *    that signs in once;
 * 4. `<cacheDir>/issued/<name>.json` must not hold an earlier key, and the
 *    key goes to the adapter when it stores values (`set`), and otherwise
 *    to that file, whose directory must be writable.
 *
 * The environment overrides are read, never written.
 */
export const prepareIssuedCredential = async (
  policy: IssuedCredentialPolicy,
  {
    name,
    env = {},
    replace,
    secrets = getConfiguredSecrets(),
    cacheDir,
  }: {
    readonly name: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly replace?: IssuedCredentialReplacement;
    /** The adapter the key is read from and stored in, the config's by default. */
    readonly secrets?: SecretsAdapter;
    /** The config's `cacheDir`, where a read-only adapter's key is written. */
    readonly cacheDir?: string | null;
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
  if (replace === undefined) {
    const held = (await secrets.get([name], { cwd }))[name];
    if (typeof held === "string" && held) return { status: "stored" };
  }

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

  const file = issuedCredentialFile(name, cacheDir, cwd);
  await refuseEarlierFile(policy, name, secrets, file);
  let target: IssuedCredentialTarget;
  if (secrets.set === undefined) {
    await prepareIssuedFile(policy, name, secrets, file);
    target = { kind: "file", secrets, file };
  } else {
    // The adapter itself, so a class keeps its methods and their receiver.
    target = { kind: "adapter", secrets: secrets as WritableSecrets, file };
  }
  return {
    status: "missing",
    target,
    env: { ...(await readLoadedHotUpdaterEnv(cwd)), ...env },
  };
};

const isEnvSecrets = (secrets: SecretsAdapter) =>
  secrets.name === envSecrets().name;

/** What each field of an issued key's JSON goes in, for the per-field variables. */
const FIELD_VARIABLES: Readonly<
  Record<IssuedCredentialKind, readonly string[]>
> = {
  "asc-api-key": [
    "HOT_UPDATER_ASC_KEY to its p8",
    "HOT_UPDATER_ASC_KEY_ID to its keyId",
    "HOT_UPDATER_ASC_ISSUER_ID to its issuerId",
  ],
  "play-service-account": [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON to the whole file (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH to a copy of it)",
  ],
};

/**
 * Where to store the key `file` holds so builds read it, naming variables,
 * never values: as one value where the read-only adapter reads `name`, or
 * in the per-field variables every adapter's builds read first.
 */
const localGuidance = (
  kind: IssuedCredentialKind,
  name: string,
  secrets: SecretsAdapter,
  file: string,
): string[] => {
  const variable = secretVariableName(name);
  return [
    isEnvSecrets(secrets)
      ? `Set ${variable} to the contents of ${file}, as one value, in the environment or .env.hotupdater (${variable}='<contents>'), so builds read it.`
      : `Store the contents of ${file} as one value at ${describeSecret(secrets, name)}, so builds read it.`,
    `Or set ${FIELD_VARIABLES[kind].join(", ")} (the file's fields).`,
  ];
};

/**
 * The per-field variables, which builds read before any secrets adapter:
 * the only ones that work whatever adapter the config sets, as the whole
 * value's variable is read through `env()`.
 */
const fieldGuidance = (kind: IssuedCredentialKind) =>
  `Set ${FIELD_VARIABLES[kind].join(", ")} (the file's fields) in the environment or .env.hotupdater, which builds read before any secrets adapter.`;

/** Where CI reads the key from: a secret the job maps to `env()`'s variable. */
const ciGuidance = (name: string, secrets: SecretsAdapter) => {
  const variable = secretVariableName(name);
  return isEnvSecrets(secrets)
    ? `In CI, store the contents as the secret ${variable} and map it into the job's environment (env: ${variable}: \${{ secrets.${variable} }}).`
    : `In CI, the job reads it from the ${secrets.name} secrets adapter, or from those variables.`;
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

/** `withIssuedKey`, reading the key from the issued key's `file`. */
export const withIssuedFile = (
  secrets: SecretsAdapter,
  name: string,
  file: string,
): SecretsAdapter =>
  withIssuedKey(secrets, name, () => fs.readFile(file, "utf-8"), file);

/**
 * Writes an issued key's `value` to `file`, 0600 and never over another
 * file, and tells the developer how to store it, naming the file and the
 * variables, never the key, and that the file goes once it is stored;
 * then, for `env()`, offers once to store it as a GitHub Actions secret.
 * The value is masked before anything can print it. A failed write throws:
 * the key is nowhere, and the caller revokes it.
 */
export const writeIssuedCredential = async ({
  policy,
  name,
  value,
  secrets,
  file,
  details = [],
  githubSecrets,
}: {
  readonly policy: IssuedCredentialPolicy;
  readonly name: string;
  readonly value: string;
  readonly secrets: SecretsAdapter;
  readonly file: string;
  /** Lines naming the key, such as its service account, after the file. */
  readonly details?: readonly string[];
  /** The adapter the GitHub Actions offer writes with. */
  readonly githubSecrets?: CreateGitHubSecrets;
}): Promise<void> => {
  registerCredentialValue(value);
  try {
    await fs.writeFile(file, value, { mode: 0o600, flag: "wx" });
  } catch (error) {
    throw new CredentialNotStoredError(
      `writing ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  p.log.warn(
    ui.block(`${policy.label} saved to a file`, [
      ui.kv("File", file),
      ...details,
      ...[
        `The ${secrets.name} secrets adapter is read-only, so Hot Updater wrote the key it issued to this file, which only you can read. Store it where builds read it, then delete the file.`,
        ...localGuidance(policy.kind, name, secrets, file),
        ciGuidance(name, secrets),
      ].map((line) => `    ${line}`),
    ]),
  );
  // CI reads the GitHub Actions secret through env(), as the variable env()
  // reads the name from: another adapter would not read it there.
  if (!isEnvSecrets(secrets)) return;
  await offerGitHubSecret({
    name,
    value,
    file,
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

/**
 * Stores an issued key's `value` as `name`, and reads it back: returns
 * whether the adapter reads it as stored, which a write-only store does
 * not. Throws `CredentialNotStoredError` only when the write failed and
 * the adapter reads back no value, or the `previous` one it replaces, so
 * the caller may revoke the key, and `CredentialStoreUnconfirmedError`
 * when nothing tells, or the adapter reads back another value: a key the
 * store may hold is never revoked.
 */
export const storeIssuedCredential = async ({
  secrets,
  name,
  value,
  previous,
}: {
  readonly secrets: WritableSecrets;
  readonly name: string;
  readonly value: string;
  /** What the adapter held as `name` before, which the key replaces. */
  readonly previous?: string;
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
    if (held === undefined || (previous !== undefined && held === previous)) {
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
 * The adapter stored the issued key and does not read it back here, as a
 * write-only store such as GitHub Actions secrets outside a workflow does:
 * builds on this machine would not find it, and the key is printed
 * nowhere. Writes a copy to `file`, 0600, with how to set it for builds
 * here, and returns the adapter this run reads the key with: from the copy,
 * or from memory when the copy can't be written, which is reported. The
 * key stays stored either way, and is never revoked.
 */
export const keepIssuedCopy = async ({
  policy,
  name,
  value,
  secrets,
  file,
}: {
  readonly policy: IssuedCredentialPolicy;
  readonly name: string;
  readonly value: string;
  readonly secrets: SecretsAdapter;
  readonly file: string;
}): Promise<SecretsAdapter> => {
  registerCredentialValue(value);
  const stored = `The ${secrets.name} secrets adapter stored ${name} (${describeSecret(secrets, name)}), and does not read it back here, so builds on this machine would not find it`;
  try {
    await prepareIssuedDirectory(file);
    await fs.writeFile(file, value, { mode: 0o600, flag: "wx" });
  } catch (error) {
    p.log.warn(
      `${stored}. Writing a copy to ${file} failed: ${error instanceof Error ? error.message : String(error)}\nThis build uses the key; builds that read the adapter where it holds the key, such as CI's, use it too.`,
    );
    return withIssuedKey(
      secrets,
      name,
      async () => value,
      describeSecret(secrets, name),
    );
  }
  p.log.warn(
    ui.block(`${policy.label} copied to a file`, [
      ui.kv("File", file),
      ...[
        `${stored}. Hot Updater wrote a copy to this file, which only you can read, and this build uses it. Builds that read the adapter where it holds the key, such as CI's, need nothing more.`,
        fieldGuidance(policy.kind),
        "Then delete the file.",
      ].map((line) => `    ${line}`),
    ]),
  );
  return withIssuedFile(secrets, name, file);
};

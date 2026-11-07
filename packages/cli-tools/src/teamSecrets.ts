import type { SecretsAdapter } from "@hot-updater/plugin-core";

import {
  getHotUpdaterEnvValue,
  readLoadedEnvFile,
  readLoadedHotUpdaterEnv,
} from "./hotUpdaterEnv";
import { loadConfig } from "./loadConfig";
import { registerSecretValue } from "./secretMasking";
import {
  describeSecret,
  getConfiguredAdapter,
  readSecrets,
  secretVariableName,
} from "./secrets";

/**
 * The client API key the managed servers' `apiKeys()` gives an app, which
 * init saves (`API_KEY_ENV` in `@hot-updater/plugin-api-keys`). The config
 * never reads it; a team store shares it with the deploy credentials, so a
 * teammate's init registers the same key again rather than a new one.
 */
export const MANAGED_CLIENT_CREDENTIAL_ENV = "HOT_UPDATER_API_KEY";

/**
 * The config's own `secrets` adapter, the team store: undefined when the
 * config sets none, which is `localSecrets()`. Loading the config runs its
 * `process.loadEnvFile(".env.hotupdater")`, which init must not see, so
 * `process.env` is restored after it.
 */
export const loadTeamSecrets = async (): Promise<
  SecretsAdapter | undefined
> => {
  const before = { ...process.env };
  try {
    return getConfiguredAdapter((await loadConfig(null)).secrets);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(before, key)) delete process.env[key];
    }
    Object.assign(process.env, before);
  }
};

/**
 * `names` neither the environment nor `env`, init's env files, sets, read
 * from `secrets` in one call: the values a teammate's init, or a run after
 * the file's lines were deleted, replays with.
 */
export const readMissingFromTeamSecrets = async (
  secrets: SecretsAdapter,
  names: readonly string[],
  {
    env,
    cwd,
  }: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
): Promise<Readonly<Record<string, string>>> => {
  const missing = names.filter(
    (name) => getHotUpdaterEnvValue(env, name) === undefined,
  );
  if (missing.length === 0) return {};
  const held = await readSecrets(secrets, missing, cwd);
  // No prototype: a variable may be named __proto__.
  const values: Record<string, string> = Object.create(null);
  for (const name of missing) {
    const value = Object.hasOwn(held, name) ? held[name] : undefined;
    if (typeof value === "string" && value !== "") {
      registerSecretValue(value);
      values[name] = value;
    }
  }
  return values;
};

/** What `storeEnvFileSecrets` did with each name the file sets. */
export interface StoredEnvFileSecrets {
  /** Written, then read back. */
  readonly stored: readonly string[];
  /** Already held with the file's value, so not written again. */
  readonly unchanged: readonly string[];
}

/**
 * The adapter holds another value for each of `names` than the env file
 * sets. Nothing was written: the stored value may be its only copy. Only
 * the names are carried, never a value.
 */
export class StoredSecretsConflictError extends Error {
  readonly names: readonly string[];

  constructor(adapter: string, names: readonly string[]) {
    super(
      `The ${adapter} secrets adapter holds ${names.length === 1 ? "another value" : "other values"} for ${list(names)}.`,
    );
    this.name = "StoredSecretsConflictError";
    this.names = names;
  }
}

/**
 * Stores each of `names` that `envFile`, `.env.hotupdater` by default,
 * holds through `secrets`, then reads them back in one call. Only the file
 * is read, never the environment. The file is left as it is. A value the
 * adapter already holds is not written again: a store that keeps versions
 * would gain a copy, and one that keeps a single previous version would
 * lose the real one. Another value it holds may be its only copy: unless
 * `replace`, any such name throws `StoredSecretsConflictError` before
 * anything is written. Returns the names written and the names already
 * held, each in the order of `names`; throws when it reads back another
 * value.
 */
export const storeEnvFileSecrets = async (
  secrets: SecretsAdapter,
  names: readonly string[],
  cwd: string,
  {
    envFile,
    replace = false,
  }: {
    /** An env file to read instead of `.env.hotupdater`, relative to `cwd`. */
    readonly envFile?: string;
    /** Overwrite another value the adapter holds. */
    readonly replace?: boolean;
  } = {},
): Promise<StoredEnvFileSecrets> => {
  const file =
    envFile === undefined
      ? await readLoadedHotUpdaterEnv(cwd)
      : await readLoadedEnvFile(envFile, cwd);
  const values = new Map<string, string>();
  for (const name of names) {
    const variable = secretVariableName(name);
    const value = Object.hasOwn(file, variable)
      ? file[variable]?.trim()
      : undefined;
    if (value) values.set(name, value);
  }
  if (values.size === 0) return { stored: [], unchanged: [] };
  for (const value of values.values()) {
    // Masked before it is sent or compared, so no failure can print it.
    registerSecretValue(value);
  }
  const before = await readSecrets(secrets, [...values.keys()], cwd);
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const [name, value] of values) {
    const held = Object.hasOwn(before, name) ? before[name] : undefined;
    if (typeof held === "string") registerSecretValue(held);
    if (held === value) unchanged.push(name);
    else {
      written.push(name);
      if (typeof held === "string") conflicts.push(name);
    }
  }
  if (conflicts.length > 0 && !replace) {
    throw new StoredSecretsConflictError(secrets.name, conflicts);
  }
  for (const name of written) {
    await secrets.set(name, values.get(name)!, { cwd });
  }
  if (written.length === 0) return { stored: [], unchanged };
  const read = await secrets.get(written, { cwd });
  const unread = written.filter(
    (name) =>
      (Object.hasOwn(read, name) ? read[name] : undefined) !== values.get(name),
  );
  if (unread.length > 0) {
    throw new Error(
      `The ${secrets.name} secrets adapter did not read back ${list(unread)} (${unread.map((name) => describeSecret(secrets, name)).join("; ")}).`,
    );
  }
  return { stored: written, unchanged };
};

const list = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

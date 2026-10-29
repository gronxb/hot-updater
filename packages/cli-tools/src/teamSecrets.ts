import type { SecretsAdapter } from "@hot-updater/plugin-core";

import {
  getHotUpdaterEnvValue,
  readLoadedEnvFile,
  readLoadedHotUpdaterEnv,
} from "./hotUpdaterEnv";
import { loadConfig } from "./loadConfig";
import { registerSecretValue } from "./secretMasking";
import { describeSecret, getConfiguredAdapter, readSecrets } from "./secrets";

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

/**
 * Stores each of `names` that `envFile`, `.env.hotupdater` by default,
 * holds through `secrets`, then reads them back in one call. Only the file
 * is read, never the environment. The file is left as it is. Returns the
 * names stored, in the order of `names`; throws when the adapter reads
 * back another value.
 */
export const storeEnvFileSecrets = async (
  secrets: SecretsAdapter,
  names: readonly string[],
  cwd: string,
  /** An env file to read instead of `.env.hotupdater`, relative to `cwd`. */
  envFile?: string,
): Promise<readonly string[]> => {
  const file =
    envFile === undefined
      ? await readLoadedHotUpdaterEnv(cwd)
      : await readLoadedEnvFile(envFile, cwd);
  const values = new Map<string, string>();
  for (const name of names) {
    const value = Object.hasOwn(file, name) ? file[name]?.trim() : undefined;
    if (value) values.set(name, value);
  }
  if (values.size === 0) return [];
  const stored = [...values.keys()];
  for (const [name, value] of values) {
    // Masked before it is sent, so no failure can print it.
    registerSecretValue(value);
    await secrets.set(name, value, { cwd });
  }
  const read = await secrets.get(stored, { cwd });
  const unread = stored.filter(
    (name) =>
      (Object.hasOwn(read, name) ? read[name] : undefined) !== values.get(name),
  );
  if (unread.length > 0) {
    throw new Error(
      `The ${secrets.name} secrets adapter did not read back ${list(unread)} (${unread.map((name) => describeSecret(secrets, name)).join("; ")}).`,
    );
  }
  return stored;
};

const list = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

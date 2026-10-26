import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { getCwd } from "./cwd";
import { getLocalKeyFile, readLocalKey, writeLocalKey } from "./localKeyStore";
import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "./hotUpdaterEnv";
import { isReservedVariableName } from "./reservedVariables";
import { registerSecretValue } from "./secretMasking";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A secret's name, as `secret:<name>` takes one. */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const SECRET_REFERENCE_PREFIX = "secret:";

/** Whether `name` is a secret's name, as `secret:<name>` takes one. */
export const isSecretName = (name: string): boolean =>
  SECRET_NAME_PATTERN.test(name);

/**
 * The secret name a config's `secret:<name>` reference names, such as
 * `release-keystore` for `"secret:release-keystore"`. `field` is the config
 * field the reference is in, which the error names.
 */
export const parseSecretReference = (
  reference: string,
  field: string,
): string => {
  const name = reference.startsWith(SECRET_REFERENCE_PREFIX)
    ? reference.slice(SECRET_REFERENCE_PREFIX.length)
    : undefined;
  if (name === undefined || !SECRET_NAME_PATTERN.test(name)) {
    throw new Error(
      `${field} names a secret as secret:<name>, such as "secret:release-keystore", and ${JSON.stringify(reference)} is not one.`,
    );
  }
  return name;
};

/**
 * The environment variable the default store reads a secret from: a name
 * that is a variable name already, such as `CLOUDFLARE_API_TOKEN`, as it
 * is, and any other, such as `asc-api-key`, upper-cased with `HOT_UPDATER_`
 * before it and every character but letters and digits as `_`
 * (`HOT_UPDATER_ASC_API_KEY`).
 */
export const secretVariableName = (name: string): string =>
  ENV_NAME_PATTERN.test(name)
    ? name
    : `HOT_UPDATER_${name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;

/** `name` from its variable in `process.env` or the project's `.env.hotupdater`. */
export const readSecretVariables = async (
  names: readonly string[],
  cwd: string,
): Promise<Record<string, string | undefined>> => {
  const fileEnv = await readLoadedHotUpdaterEnv(cwd);
  // No prototype: a secret may be named __proto__.
  const values: Record<string, string | undefined> = Object.create(null);
  for (const name of names) {
    values[name] = getHotUpdaterEnvValue(fileEnv, secretVariableName(name));
  }
  return values;
};

/** The `secrets` adapter's name when the config sets none. */
export const DEFAULT_SECRETS_NAME = "default";

const LOCAL_KEY_STORE = Symbol.for("@hot-updater/cli-tools/local-key-store");

type LocalKeyStoreSecrets = SecretsAdapter & {
  /** The config's own adapter; undefined for the default. */
  readonly [LOCAL_KEY_STORE]: { readonly configured?: SecretsAdapter };
};

const isLocalKeyStoreSecrets = (
  secrets: SecretsAdapter,
): secrets is LocalKeyStoreSecrets => LOCAL_KEY_STORE in secrets;

/**
 * The config's `secrets` adapter, or the environment when it sets none,
 * with this machine's key store after it: `get` reads each name the
 * adapter does not hold from `~/.hot-updater/keys/<project-key>/<name>.json`,
 * and `set` stores there when the adapter stores nothing. Keys Hot Updater
 * issues, and credentials `secrets put` imports, are reused by the next
 * build on this machine with no step in between.
 */
export const withLocalKeyStore = (
  configured?: SecretsAdapter,
): SecretsAdapter => {
  if (configured && isLocalKeyStoreSecrets(configured)) return configured;
  const describeFile = (name: string) => getLocalKeyFile(name, getCwd());
  const adapter: LocalKeyStoreSecrets = {
    name: configured?.name ?? DEFAULT_SECRETS_NAME,
    [LOCAL_KEY_STORE]: configured ? { configured } : {},
    get: async (names, context) => {
      const values = configured
        ? { ...(await configured.get(names, context)) }
        : await readSecretVariables(names, context.cwd);
      // No prototype: a secret may be named __proto__.
      const read: Record<string, string | undefined> = Object.create(null);
      for (const name of names) {
        const value = Object.hasOwn(values, name) ? values[name] : undefined;
        read[name] =
          typeof value === "string" && value
            ? value
            : await readLocalKey(name, context.cwd);
      }
      return read;
    },
    set: async (name, value, context) => {
      if (configured?.set) {
        await configured.set(name, value, context);
        return;
      }
      await writeLocalKey(name, value, context.cwd);
    },
    describe: (name) =>
      configured
        ? `${describeSecret(configured, name)}, or ${describeFile(name)} on this machine`
        : `${secretVariableName(name)} in the environment, or ${describeFile(name)} on this machine`,
  };
  return adapter;
};

/**
 * The config's own `secrets` adapter, without this machine's key store:
 * undefined when the config sets none. `secretEnv` reads deploy
 * credentials from it.
 */
export const getConfiguredAdapter = (
  secrets: SecretsAdapter,
): SecretsAdapter | undefined =>
  isLocalKeyStoreSecrets(secrets) ? secrets[LOCAL_KEY_STORE].configured : secrets;

/**
 * Whether a key `secrets` stores stays on this machine: the default store,
 * and `githubActions()`, whose secrets builds here read from the key
 * store, as GitHub returns no value.
 */
export const keepsKeysOnThisMachine = (secrets: SecretsAdapter): boolean => {
  const configured = getConfiguredAdapter(secrets);
  return configured === undefined || configured.name === "githubActions";
};

const CONFIGURED_SECRETS = Symbol.for("@hot-updater/cli-tools/secrets");
const LOADING_SCOPE = Symbol.for("@hot-updater/cli-tools/secrets-scope");

/**
 * The `secrets` adapter of one config load, filled once the config it
 * evaluates resolves: each `secretEnv` the evaluation creates reads from it.
 */
export interface SecretsScope {
  secrets?: SecretsAdapter;
}

type SecretsSlot = {
  [CONFIGURED_SECRETS]?: SecretsAdapter;
  [LOADING_SCOPE]?: SecretsScope;
};

/**
 * Evaluates a config, the file or a config function, with `scope` as the
 * scope of every `secretEnv` it creates, so each reads the `secrets` of the
 * config that created it, whatever config loads after. It is kept on
 * `globalThis`: the config file loads its own copy of Hot Updater's modules.
 */
export const withSecretsScope = async <T>(
  scope: SecretsScope,
  evaluate: () => Promise<T> | T,
): Promise<T> => {
  const slot = globalThis as SecretsSlot;
  const previous = slot[LOADING_SCOPE];
  slot[LOADING_SCOPE] = scope;
  try {
    return await evaluate();
  } finally {
    slot[LOADING_SCOPE] = previous;
  }
};

/**
 * Makes `secrets` the adapter a credential resolver reads from by default,
 * and a `secretEnv` created outside any config load, as `loadConfig` does
 * with the config's. It is kept on `globalThis`: the config file loads Hot
 * Updater's modules again, as its own copies.
 */
export const setConfiguredSecrets = (secrets: SecretsAdapter): void => {
  (globalThis as SecretsSlot)[CONFIGURED_SECRETS] = secrets;
};

/**
 * The config's `secrets` adapter with this machine's key store
 * (`withLocalKeyStore`), the default store until a config loads.
 */
export const getConfiguredSecrets = (): SecretsAdapter =>
  (globalThis as SecretsSlot)[CONFIGURED_SECRETS] ?? withLocalKeyStore();

/** Where an adapter keeps `name`, for messages. */
export const describeSecret = (secrets: SecretsAdapter, name: string) =>
  secrets.describe?.(name) ?? `${name} in ${secrets.name}`;

const list = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

/**
 * Environment variables from the `secrets` adapter of the config that
 * creates it, as a function a config calls when an adapter needs them, so loading
 * `hot-updater.config.ts` reads no secret. Each name set in the environment
 * or `.env.hotupdater` wins; the others are read from the config's
 * `secrets` adapter in one call, and without one they must be set. The values go only to the caller: they are never set in
 * `process.env`, and are masked in the CLI's logs. Names a loader or
 * interpreter reads, such as `NODE_OPTIONS`, are refused.
 *
 * @example
 * const deploy = secretEnv(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
 * s3Storage({
 *   bucketName: "bundles",
 *   region: "us-east-1",
 *   credentials: async () => {
 *     const env = await deploy();
 *     return {
 *       accessKeyId: env.S3_ACCESS_KEY_ID,
 *       secretAccessKey: env.S3_SECRET_ACCESS_KEY,
 *     };
 *   },
 * });
 */
export const secretEnv = <const TName extends string>(
  names: readonly TName[],
): (() => Promise<Readonly<Record<TName, string>>>) => {
  const wanted = [...new Set(names)];
  const invalid = wanted.filter((name) => !ENV_NAME_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new Error(
      `secretEnv takes environment variable names: letters, digits, and underscores, not starting with a digit, and ${invalid.map((name) => JSON.stringify(name)).join(", ")} ${invalid.length === 1 ? "is" : "are"} not.`,
    );
  }
  const reserved = wanted.filter(isReservedVariableName);
  if (reserved.length > 0) {
    throw new Error(
      `secretEnv refuses ${list(reserved)}: ${reserved.length === 1 ? "it changes" : "they change"} how a process loads code or which credentials Hot Updater uses.`,
    );
  }
  const scope = (globalThis as SecretsSlot)[LOADING_SCOPE];
  return async () => {
    const cwd = getCwd();
    const fileEnv = await readLoadedHotUpdaterEnv(cwd);
    // No prototype: a variable may be named __proto__.
    const variables: Record<string, string> = Object.create(null);
    const fromStore: string[] = [];
    for (const name of wanted) {
      const value = getHotUpdaterEnvValue(fileEnv, name);
      if (value === undefined) fromStore.push(name);
      else variables[name] = value;
    }
    if (fromStore.length > 0) {
      // Deploy credentials come from the config's own adapter: this
      // machine's key store holds only the keys Hot Updater stores.
      const secrets = getConfiguredAdapter(
        scope?.secrets ?? getConfiguredSecrets(),
      );
      const read = secrets ? await secrets.get(fromStore, { cwd }) : {};
      const missing = fromStore.filter((name) => {
        const value = Object.hasOwn(read, name) ? read[name] : undefined;
        if (typeof value !== "string" || value === "") return true;
        variables[name] = value;
        return false;
      });
      if (missing.length > 0) {
        const them = missing.length === 1 ? "it" : "them";
        throw new Error(
          secrets === undefined
            ? `secretEnv found no value for ${list(missing)}: set ${them} in the environment or .env.hotupdater, or read ${them} from a secrets store with the config's secrets.`
            : `secretEnv found no value for ${list(missing)}: ${missing.length === 1 ? "it is" : "they are"} not set in the environment or .env.hotupdater, and the ${secrets.name} secrets adapter does not hold ${them} (${missing.map((name) => describeSecret(secrets, name)).join("; ")}).`,
        );
      }
    }
    for (const value of Object.values(variables)) registerSecretValue(value);
    return Object.freeze(variables) as Readonly<Record<TName, string>>;
  };
};

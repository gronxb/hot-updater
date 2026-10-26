import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { getCwd } from "./cwd";
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
 * The environment variable `envSecrets()` reads a secret from: a name that is a
 * variable name already, such as `CLOUDFLARE_API_TOKEN`, as it is, and any
 * other, such as `asc-api-key`, upper-cased with `HOT_UPDATER_` before it
 * and every character but letters and digits as `_`
 * (`HOT_UPDATER_ASC_API_KEY`).
 */
export const secretVariableName = (name: string): string =>
  ENV_NAME_PATTERN.test(name)
    ? name
    : `HOT_UPDATER_${name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;

const ENV_SECRETS_NAME = "envSecrets";

/**
 * Secrets from the environment, the default `secrets` adapter: each name
 * from its variable (`secretVariableName`), in `process.env` or the
 * project's `.env.hotupdater`. A credential is one JSON value, such as
 * `HOT_UPDATER_ASC_API_KEY={"keyId":…,"issuerId":…,"p8":…}`; the CLI also
 * reads each credential's per-field variables, such as
 * `HOT_UPDATER_ASC_KEY_ID`, before any adapter. Read-only: Hot Updater
 * never writes the environment.
 */
export const envSecrets = (): SecretsAdapter => ({
  name: ENV_SECRETS_NAME,
  get: async (names, { cwd }) => {
    const fileEnv = await readLoadedHotUpdaterEnv(cwd);
    // No prototype: a secret may be named __proto__.
    const values: Record<string, string | undefined> = Object.create(null);
    for (const name of names) {
      values[name] = getHotUpdaterEnvValue(fileEnv, secretVariableName(name));
    }
    return values;
  },
  describe: (name) =>
    `${secretVariableName(name)} in the environment or .env.hotupdater`,
});

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

/** The config's `secrets` adapter, `envSecrets()` until a config sets another. */
export const getConfiguredSecrets = (): SecretsAdapter =>
  (globalThis as SecretsSlot)[CONFIGURED_SECRETS] ?? envSecrets();

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
 * or `.env.hotupdater` wins; the others are read from the adapter in one
 * call. The values go only to the caller: they are never set in
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
      const secrets = scope?.secrets ?? getConfiguredSecrets();
      const read = await secrets.get(fromStore, { cwd });
      const missing = fromStore.filter((name) => {
        const value = Object.hasOwn(read, name) ? read[name] : undefined;
        if (typeof value !== "string" || value === "") return true;
        variables[name] = value;
        return false;
      });
      if (missing.length > 0) {
        const them = missing.length === 1 ? "it" : "them";
        throw new Error(
          secrets.name === ENV_SECRETS_NAME
            ? `secretEnv found no value for ${list(missing)}: set ${them} in the environment or .env.hotupdater, or read ${them} from a secrets store with the config's secrets.`
            : `secretEnv found no value for ${list(missing)}: ${missing.length === 1 ? "it is" : "they are"} not set in the environment or .env.hotupdater, and the ${secrets.name} secrets adapter does not hold ${them} (${missing.map((name) => describeSecret(secrets, name)).join("; ")}).`,
        );
      }
    }
    for (const value of Object.values(variables)) registerSecretValue(value);
    return Object.freeze(variables) as Readonly<Record<TName, string>>;
  };
};

import type { SecretRef, SecretsAdapter } from "@hot-updater/plugin-core";

import { getCwd } from "./cwd";
import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "./hotUpdaterEnv";
import {
  createLocalSecretsStore,
  type LocalSecretsStore,
} from "./localKeyStore";
import { isReservedVariableName } from "./reservedVariables";
import { registerSecretValue } from "./secretMasking";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A secret's name, as `secret("<name>")` takes one. */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * The brand `secret()` sets, which plugin-core's `SecretRef` types. It is a
 * `Symbol.for` key: the config file loads its own copy of this module.
 */
const SECRET_REF = Symbol.for("@hot-updater/secret-ref");

/** Whether `name` is a secret's name, as `secret("<name>")` takes one. */
export const isSecretName = (name: string): boolean =>
  SECRET_NAME_PATTERN.test(name);

/** Whether `value` is a `secret("<name>")` reference. */
export const isSecretRef = (value: unknown): value is SecretRef =>
  typeof value === "function" &&
  Reflect.get(value, SECRET_REF) === true &&
  isSecretName(value.name);

/**
 * The secret name a config's `secret("<name>")` names, such as
 * `release-keystore` for `secret("release-keystore")`. `field` is the
 * config field it is in, which the error names.
 */
export const parseSecretReference = (
  reference: unknown,
  field: string,
): string => {
  if (!isSecretRef(reference)) {
    throw new Error(`${field} takes secret("<name>").`);
  }
  return reference.name;
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

/** `localSecrets()`'s name, the `secrets` adapter when the config sets none. */
export const LOCAL_SECRETS_NAME = "localSecrets";

const LOCAL_KEY_STORE = Symbol.for("@hot-updater/cli-tools/local-key-store");

type LocalKeyStoreSecrets = SecretsAdapter & {
  readonly [LOCAL_KEY_STORE]: { readonly store: LocalSecretsStore };
};

const isLocalKeyStoreSecrets = (
  secrets: SecretsAdapter,
): secrets is LocalKeyStoreSecrets => LOCAL_KEY_STORE in secrets;

/**
 * Secrets in JSON files on this machine, the `secrets` adapter when the
 * config sets none: `get` reads each name from its environment variable
 * (`secretVariableName`, in `process.env` or `.env.hotupdater`), then from
 * `~/.hot-updater/secrets/<project-key>/<name>.json`; `set` writes that
 * file, 0600 in a 0700 directory, outside the project, so it survives
 * `node_modules` and is never committed. `HOT_UPDATER_HOME` moves
 * `~/.hot-updater`. The project key hashes the checkout's real path
 * (`getProjectKey`), so each clone of an app has its own directory, and
 * another clone or machine signs in and issues a key of its own.
 *
 * @example
 * export default defineConfig({ secrets: localSecrets(), ... });
 */
export const localSecrets = (
  options: LocalSecretsOptions = {},
): SecretsAdapter => createLocalSecrets(createLocalSecretsStore(options));

export interface LocalSecretsOptions {
  /**
   * The directory that holds this project's secrets, one `<name>.json`
   * each, such as `~/.hot-updater/secrets/my-app`: `~` is the home
   * directory, and a relative path is the project's. A directory in a git
   * work tree must be one git ignores. Defaults to
   * `~/.hot-updater/secrets/<project-key>`, whose key hashes the
   * checkout's real path, one per clone (`getProjectKey`).
   */
  readonly path?: string;
}

/**
 * The `secrets` adapter a config load uses: the config's own adapter as it
 * is, with no store on this machine under it, or `localSecrets()` when the
 * config sets none.
 */
export const resolveSecretsAdapter = (
  configured?: SecretsAdapter,
): SecretsAdapter => configured ?? localSecrets();

const createLocalSecrets = (store: LocalSecretsStore): SecretsAdapter => {
  const adapter: LocalKeyStoreSecrets = {
    name: LOCAL_SECRETS_NAME,
    [LOCAL_KEY_STORE]: { store },
    get: async (names, context) => {
      const values = await readSecretVariables(names, context.cwd);
      // No prototype: a secret may be named __proto__.
      const read: Record<string, string | undefined> = Object.create(null);
      for (const name of names) {
        read[name] = values[name] || (await store.read(name, context.cwd));
      }
      return read;
    },
    set: async (name, value, context) => {
      await store.write(name, value, context.cwd);
    },
    describe: (name) =>
      `${secretVariableName(name)} in the environment, or ${store.file(name, getCwd())} on this machine`,
  };
  return adapter;
};

/**
 * `localSecrets()`'s store, for `localSecrets()` itself; undefined for any
 * other adapter, which keeps nothing on this machine.
 */
export const getLocalSecretsStore = (
  secrets: SecretsAdapter,
): LocalSecretsStore | undefined =>
  isLocalKeyStoreSecrets(secrets) ? secrets[LOCAL_KEY_STORE].store : undefined;

/**
 * The config's own `secrets` adapter: undefined for `localSecrets()`,
 * which is the adapter when the config sets none. A called `secret()` reads
 * from it.
 */
export const getConfiguredAdapter = (
  secrets: SecretsAdapter,
): SecretsAdapter | undefined =>
  isLocalKeyStoreSecrets(secrets) ? undefined : secrets;

/**
 * Where `secrets.set` stores `name`, for messages: the config's adapter,
 * else `localSecrets()`'s file.
 */
export const describeStoredSecret = (
  secrets: SecretsAdapter,
  name: string,
): string =>
  getLocalSecretsStore(secrets)?.file(name, getCwd()) ??
  describeSecret(secrets, name);

/**
 * `name`'s value, read in the order `secrets.get` reads it, with the one
 * place it came from, for messages: the config's adapter
 * (`describeSecret`), the environment variable `localSecrets()` reads
 * first, or `localSecrets()`'s file. Undefined when nothing holds it.
 */
export const readSecretWithSource = async (
  secrets: SecretsAdapter,
  name: string,
  cwd: string,
): Promise<{ readonly value: string; readonly source: string } | undefined> => {
  const held = (value: string | undefined): value is string =>
    typeof value === "string" && value.length > 0;
  const store = getLocalSecretsStore(secrets);
  if (!store) {
    const value = (await readSecrets(secrets, [name], cwd))[name];
    return held(value)
      ? { value, source: describeSecret(secrets, name) }
      : undefined;
  }
  const variable = (await readSecretVariables([name], cwd))[name];
  if (held(variable)) {
    return {
      value: variable,
      source: `${secretVariableName(name)} (environment)`,
    };
  }
  const value = await store.read(name, cwd).catch((error: unknown) => {
    throw secretReadError(secrets, [name], error);
  });
  return held(value) ? { value, source: store.file(name, cwd) } : undefined;
};

/**
 * Whether a key `secrets` stores stays on this machine: it is `localSecrets()`,
 * whose files no other machine reads.
 */
export const keepsKeysOnThisMachine = (secrets: SecretsAdapter): boolean =>
  getConfiguredAdapter(secrets) === undefined;

const CONFIGURED_SECRETS = Symbol.for("@hot-updater/cli-tools/secrets");
const LOADING_SCOPE = Symbol.for("@hot-updater/cli-tools/secrets-scope");

/**
 * The `secrets` adapter of one config load, filled once the config it
 * evaluates resolves: each `secret()` the evaluation creates reads from it,
 * and adds its name to `names`.
 */
export interface SecretsScope {
  secrets?: SecretsAdapter;
  names?: Set<string>;
  /**
   * The names build credentials reference, such as `signing.keystore`'s,
   * which the CLI reads for their kind: the batched read leaves them out.
   */
  buildNames?: Set<string>;
  /** The one read of the scope's other names, once a `secret()` is called. */
  read?: Promise<Readonly<Record<string, string | undefined>>>;
}

type SecretsSlot = {
  [CONFIGURED_SECRETS]?: SecretsAdapter;
  [LOADING_SCOPE]?: SecretsScope;
};

/**
 * Evaluates a config, the file or a config function, with `scope` as the
 * scope of every `secret()` it creates, so each reads the `secrets` of the
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
 * and a `secret()` created outside any config load, as `loadConfig` does
 * with the config's. It is kept on `globalThis`: the config file loads Hot
 * Updater's modules again, as its own copies.
 */
export const setConfiguredSecrets = (secrets: SecretsAdapter): void => {
  (globalThis as SecretsSlot)[CONFIGURED_SECRETS] = secrets;
};

/**
 * The config's `secrets` adapter (`resolveSecretsAdapter`), `localSecrets()`
 * until a config loads.
 */
export const getConfiguredSecrets = (): SecretsAdapter =>
  (globalThis as SecretsSlot)[CONFIGURED_SECRETS] ?? localSecrets();

/**
 * `names` from `secrets` in one `get`. A read that fails names the secrets
 * and the adapter, with the adapter's own error on the next line, such as
 * `EACCES: permission denied, open '<file>'`.
 */
export const readSecrets = async (
  secrets: SecretsAdapter,
  names: readonly string[],
  cwd: string,
): Promise<Readonly<Record<string, string | undefined>>> => {
  try {
    return await secrets.get(names, { cwd });
  } catch (error) {
    throw secretReadError(secrets, names, error);
  }
};

const secretReadError = (
  secrets: SecretsAdapter,
  names: readonly string[],
  error: unknown,
) =>
  new Error(
    `Couldn't read ${list(names)} from the ${secrets.name} secrets adapter.\n${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
    { cause: error },
  );

/** Where an adapter keeps `name`, for messages. */
export const describeSecret = (secrets: SecretsAdapter, name: string) =>
  secrets.describe?.(name) ?? `${name} in ${secrets.name}`;

const list = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

/**
 * `secret("<name>")`: the secret `name` in `hot-updater.config.ts`, for a
 * build credential, such as `signing.keystore`, or any adapter credential,
 * which calls it on first use, so loading the config reads no secret.
 * Called, it reads `name`'s variable (`secretVariableName`) in the
 * environment or `.env.hotupdater`, else the config's `secrets` adapter:
 * the first call reads every name the config's `secret()`s reference and
 * the environment doesn't set, in one `get`. With `localSecrets()`, the
 * variable must be set: its files hold only the keys Hot Updater stores.
 * Values are masked in the CLI's logs and never set in `process.env`.
 * Names a loader or interpreter reads, such as `NODE_OPTIONS`, are refused.
 * A server passes its own environment's values instead.
 *
 * @example
 * r2Storage({
 *   bucketName: "bundles",
 *   accountId: "<account-id>",
 *   credentials: {
 *     accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
 *     secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
 *   },
 * });
 */
export const secret = (name: string): SecretRef => {
  if (typeof name !== "string" || !isSecretName(name)) {
    throw new Error(
      `secret() takes up to 64 letters, digits, ".", "_", and "-", starting with a letter or digit, and ${JSON.stringify(name)} is not that.`,
    );
  }
  if (isReservedVariableName(name)) {
    throw new Error(
      `secret() refuses ${name}: it changes how a process loads code or which credentials Hot Updater uses.`,
    );
  }
  const scope = (globalThis as SecretsSlot)[LOADING_SCOPE];
  if (scope) (scope.names ??= new Set()).add(name);
  // One read per command: every adapter that calls it shares its value.
  let read: Promise<string> | undefined;
  const ref = () =>
    (read ??= readSecretRef(name, scope).catch((error: unknown) => {
      read = undefined;
      throw error;
    }));
  Object.defineProperty(ref, "name", { value: name });
  Object.defineProperty(ref, SECRET_REF, { value: true });
  return Object.freeze(ref) as SecretRef;
};

/**
 * The scope's names to read in one `get`: those no build credential takes
 * and the environment doesn't set, with `name`.
 */
const batchedNames = (
  scope: SecretsScope,
  name: string,
  fileEnv: Readonly<Record<string, string>>,
) => {
  const names = [...(scope.names ?? [])].filter(
    (candidate) =>
      !scope.buildNames?.has(candidate) &&
      getHotUpdaterEnvValue(fileEnv, secretVariableName(candidate)) ===
        undefined,
  );
  return names.includes(name) ? names : [...names, name];
};

const readSecretRef = async (
  name: string,
  scope: SecretsScope | undefined,
): Promise<string> => {
  const cwd = getCwd();
  const fileEnv = await readLoadedHotUpdaterEnv(cwd);
  const variable = secretVariableName(name);
  const fromEnv = getHotUpdaterEnvValue(fileEnv, variable);
  if (fromEnv !== undefined && fromEnv !== "") {
    registerSecretValue(fromEnv);
    return fromEnv;
  }
  // Adapter credentials come from the config's own adapter: `localSecrets()`'s
  // store holds only the keys Hot Updater stores.
  const secrets = getConfiguredAdapter(
    scope?.secrets ?? getConfiguredSecrets(),
  );
  if (secrets === undefined) {
    throw new Error(
      `secret("${name}") has no value: set ${variable} in the environment or .env.hotupdater, or set the config's secrets to a team store.`,
    );
  }
  let values: Readonly<Record<string, string | undefined>> | undefined;
  if (scope) {
    scope.read ??= readSecrets(
      secrets,
      batchedNames(scope, name, fileEnv),
      cwd,
    ).catch((error: unknown) => {
      scope.read = undefined;
      throw error;
    });
    values = await scope.read;
  }
  if (!values || !Object.hasOwn(values, name)) {
    values = await readSecrets(secrets, [name], cwd);
  }
  const value = Object.hasOwn(values, name) ? values[name] : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `secret("${name}") has no value: ${variable} is not set in the environment or .env.hotupdater, and the ${secrets.name} secrets adapter does not hold it (${describeSecret(secrets, name)}).`,
    );
  }
  registerSecretValue(value);
  return value;
};

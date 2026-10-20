import type { VaultSecretKind } from "@hot-updater/server/plugins";

import { getCwd } from "./cwd";
import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "./hotUpdaterEnv";
import { registerSecretValue } from "./secretMasking";
import {
  createVaultClient,
  readVaultConnection,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  type VaultSecretMetadata,
} from "./vaultClient";

/** The kinds whose values are environment variables, by name. */
const VARIABLE_KINDS: readonly VaultSecretKind[] = [
  "deploy-credentials",
  "generic",
];

/** The variables a key/value secret's metadata lists, as the Console derives them. */
export const vaultSecretVariables = (
  secret: VaultSecretMetadata,
): readonly string[] => {
  const { variables } = secret.metadata;
  return Array.isArray(variables)
    ? variables.filter((name): name is string => typeof name === "string")
    : [];
};

const quoted = (names: readonly string[]) =>
  names.map((name) => `"${name}"`).join(", ");

export interface ResolveVaultVariablesOptions {
  /** The variables to resolve; without it, every one the secrets list but those `except` keeps out. */
  readonly names?: readonly string[];
  /** The variables to leave out when `names` is not given, such as those set already. */
  readonly except?: (name: string) => boolean;
  /** The kinds whose secrets set variables; `deploy-credentials` and `generic` by default. */
  readonly kinds?: readonly VaultSecretKind[];
}

/**
 * The variables of the vault's key/value secrets that the token reaches:
 * those `names` lists, or every one but those `except` keeps out. A secret
 * lists its variables in its metadata, which the Console derives when it
 * stores the secret, and resolving those secrets is one more request, none
 * when no variable is wanted. Each value is masked in logs. A variable two
 * secrets set is refused, naming both.
 */
export const resolveVaultVariables = async (
  client: VaultClient,
  {
    names,
    except = () => false,
    kinds = VARIABLE_KINDS,
  }: ResolveVaultVariablesOptions = {},
): Promise<Record<string, string>> => {
  const secrets = (await client.list()).filter((secret) =>
    kinds.includes(secret.kind),
  );
  const holders = new Map<string, string[]>();
  for (const secret of secrets) {
    for (const variable of vaultSecretVariables(secret)) {
      holders.set(variable, [...(holders.get(variable) ?? []), secret.name]);
    }
  }
  const wanted = names ?? [...holders.keys()].filter((name) => !except(name));
  const missing = wanted.filter((name) => !holders.has(name));
  if (missing.length > 0) {
    throw new Error(
      `No ${kinds.join(" or ")} secret the vault token reaches at ${client.url} sets ${missing.join(", ")}. Store ${missing.length === 1 ? "it" : "them"} with hot-updater secrets put, or set ${missing.length === 1 ? "it" : "them"} in the environment.`,
    );
  }
  for (const name of wanted) {
    const from = holders.get(name)!;
    if (from.length > 1) {
      throw new Error(
        `${name} is set by the vault's secrets ${quoted(from)}: keep it in one of them.`,
      );
    }
  }
  const secretNames = [
    ...new Set(wanted.map((name) => holders.get(name)![0]!)),
  ];
  if (secretNames.length === 0) return {};

  const { secrets: resolved } = await client.resolve(secretNames);
  const values = new Map(
    resolved.map((secret) => [
      secret.name,
      (typeof secret.value === "object" && secret.value !== null
        ? secret.value
        : {}) as Record<string, unknown>,
    ]),
  );
  // No prototype: a variable may be named __proto__.
  const variables: Record<string, string> = Object.create(null);
  for (const name of wanted) {
    const secretName = holders.get(name)![0]!;
    const value = values.get(secretName)?.[name];
    if (typeof value !== "string") {
      throw new Error(
        `The vault's ${secretName} lists ${name} but holds no value for it: store it again with hot-updater secrets put.`,
      );
    }
    registerSecretValue(value);
    variables[name] = value;
  }
  return variables;
};

/**
 * The vault's deploy credentials could not be read before
 * `hot-updater.config.ts` loaded: the Console was unreachable, refused the
 * token, or holds a variable twice. The CLI reports its message alone.
 */
export class VaultDeployCredentialsError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "VaultDeployCredentialsError";
  }
}

/** Each directory's deploy credentials, resolved once per process. */
const resolved = new Map<string, Promise<Readonly<Record<string, string>>>>();
/** What the last load replaced in `process.env`, to restore before the next. */
const replaced = new Map<string, string | undefined>();

const resolveDeployCredentials = async (
  cwd: string,
): Promise<Readonly<Record<string, string>>> => {
  const fileEnv = await readLoadedHotUpdaterEnv(cwd);
  const read = readVaultConnection(fileEnv);
  if (!read.ok) return {};
  try {
    return await resolveVaultVariables(createVaultClient(read.connection), {
      kinds: ["deploy-credentials"],
      // Set, not empty, in the environment or the file.
      except: (name) =>
        getHotUpdaterEnvValue({}, name) !== undefined ||
        Boolean(Object.hasOwn(fileEnv, name) && fileEnv[name]?.trim()),
    });
  } catch (error) {
    throw new VaultDeployCredentialsError(
      `${(error as Error).message} hot-updater.config.ts reads the vault's deploy-credentials while ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} are set; set the variables it needs in the environment or .env.hotupdater to load it without the Console.`,
      { cause: error },
    );
  }
};

/**
 * Sets the variables of the vault's `deploy-credentials` secrets in
 * `process.env` before `hot-updater.config.ts` loads, when
 * `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN` are both set in
 * the environment or in `cwd`'s `.env.hotupdater`. A config then reads them
 * from `process.env` as it reads `.env.hotupdater`'s, and a variable set in
 * either wins and never reaches the Console. Once per directory and process:
 * a list, and a resolve when a variable is wanted. Each load first restores
 * what the last one set, so a directory never reads another's credentials.
 * A Console that cannot answer fails the load, naming it.
 */
export const loadVaultDeployCredentials = async (
  cwd = getCwd(),
): Promise<void> => {
  for (const [name, original] of replaced) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  replaced.clear();
  const pending = resolved.get(cwd) ?? resolveDeployCredentials(cwd);
  resolved.set(cwd, pending);
  for (const [name, value] of Object.entries(await pending)) {
    replaced.set(name, process.env[name]);
    process.env[name] = value;
  }
};

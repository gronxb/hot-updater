import fs from "node:fs/promises";
import path from "node:path";

import { ASC_INTEGRATIONS_URL } from "@hot-updater/apple-helper";
import {
  CREDENTIAL_ENV_NAMES,
  type CredentialKind,
  credentialIssueCommand,
  credentialLoginCommand,
  credentialPutCommand,
  describeSecret,
  describeStoredSecret,
  getConfiguredAdapter,
  getCwd,
  getHotUpdaterEnvValue,
  isSecretName,
  type IssuedCredentialKind,
  loadConfig,
  nonInteractiveReason,
  p,
  readLoadedHotUpdaterEnv,
  registerCredentialValue,
  secretVariableName,
} from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { ensureAscApiKey } from "../utils/native/ascApiKey";
import {
  ensurePlayServiceAccount,
  serviceAccountKeysUrl,
} from "../utils/native/playServiceAccount";

/** The kinds `secrets put` stores, as `secret:` references resolve them. */
export const SECRET_KINDS = [
  "asc-api-key",
  "android-keystore",
  "play-service-account",
] as const satisfies readonly CredentialKind[];

/** The kinds `secrets issue` issues after a sign-in. */
export const ISSUED_KINDS = [
  "asc-api-key",
  "play-service-account",
] as const satisfies readonly IssuedCredentialKind[];

/** Reports a failure with exit code 1, as the server's commands do. */
const reportFailure = async (run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

export interface SecretsPutOptions {
  readonly kind: CredentialKind;
  /** asc-api-key: the `.p8` file. */
  readonly p8?: string;
  readonly keyId?: string;
  readonly issuerId?: string;
  /** android-keystore: the keystore file. */
  readonly keystore?: string;
  readonly keyAlias?: string;
  /** play-service-account: the service account's JSON key file. */
  readonly serviceAccount?: string;
}

type ValueFlag = Exclude<keyof SecretsPutOptions, "kind">;

/** The flags each kind takes, as `--help` names them. */
const KIND_FLAGS: Readonly<Record<CredentialKind, readonly ValueFlag[]>> = {
  "asc-api-key": ["p8", "keyId", "issuerId"],
  "android-keystore": ["keystore", "keyAlias"],
  "play-service-account": ["serviceAccount"],
};

const FLAG_NAMES: Readonly<Record<ValueFlag, string>> = {
  p8: "--p8 <file>",
  keyId: "--key-id <id>",
  issuerId: "--issuer-id <id>",
  keystore: "--keystore <file>",
  keyAlias: "--key-alias <alias>",
  serviceAccount: "--service-account <file>",
};

const readFile = async (file: string, flag: string) => {
  try {
    return await fs.readFile(path.resolve(file));
  } catch {
    throw new Error(`${flag} does not point to a readable file.`);
  }
};

/** A password from its environment variable, else a hidden prompt. */
const readPassword = async (envName: string, message: string) => {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const reason = nonInteractiveReason();
  if (reason !== undefined) {
    throw new Error(`Set ${envName}: the CLI asks for no password ${reason}.`);
  }
  const answer = await p.password({ message });
  if (p.isCancel(answer) || !answer) {
    throw new Error(`No password was given for ${envName}.`);
  }
  return answer;
};

/**
 * The value `secrets put` stores: one JSON value per credential, as the
 * credential resolver reads it, `{"keyId","issuerId","p8"}` for an App
 * Store Connect key, `{"keystore","storePassword","keyAlias","keyPassword"}`
 * with the keystore in base64, and a service account's own JSON.
 */
const readSecretValue = async (options: SecretsPutOptions): Promise<string> => {
  const { kind } = options;
  const foreign = Object.values(KIND_FLAGS)
    .flat()
    .filter(
      (flag) => !KIND_FLAGS[kind].includes(flag) && options[flag] !== undefined,
    );
  if (foreign.length > 0) {
    throw new Error(
      `A ${kind} takes ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}, not ${[...new Set(foreign)].map((flag) => FLAG_NAMES[flag]).join(", ")}.`,
    );
  }
  const required = (flag: ValueFlag) => {
    const value = options[flag];
    if (!value) throw new Error(`A ${kind} needs ${FLAG_NAMES[flag]}.`);
    return value;
  };

  switch (kind) {
    case "asc-api-key": {
      const p8 = (await readFile(required("p8"), "--p8")).toString("utf-8");
      return JSON.stringify({
        keyId: required("keyId"),
        issuerId: required("issuerId"),
        p8,
      });
    }
    case "android-keystore": {
      const keystore = (
        await readFile(required("keystore"), "--keystore")
      ).toString("base64");
      const keyAlias = required("keyAlias");
      return JSON.stringify({
        keystore,
        storePassword: await readPassword(
          "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
          "Keystore password",
        ),
        keyAlias,
        keyPassword: await readPassword(
          "HOT_UPDATER_ANDROID_KEY_PASSWORD",
          `Password of the key ${keyAlias}`,
        ),
      });
    }
    case "play-service-account": {
      const json = (
        await readFile(required("serviceAccount"), "--service-account")
      ).toString("utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "--service-account is not a service account JSON key file.",
        );
      }
      return json;
    }
  }
};

/** Whether `secrets put` was given any part of a value to store. */
const hasValueFlags = (options: SecretsPutOptions) =>
  Object.values(KIND_FLAGS)
    .flat()
    .some((flag) => options[flag] !== undefined);

const isIssuedKind = (kind: string): kind is IssuedCredentialKind =>
  (ISSUED_KINDS as readonly string[]).includes(kind);

const assertSecretName = (name: string) => {
  if (!isSecretName(name)) {
    throw new Error(
      `"${name}" is no secret name: letters, digits, ".", "_", and "-", starting with a letter or a digit, up to 64 characters.`,
    );
  }
};

/**
 * `secrets put`: stores a build credential you have as `name` through the
 * config's `secrets` adapter, or `localSecrets()`'s store by default, as
 * one JSON value that `secret:<name>` resolves. It never signs in:
 * `secrets issue` does.
 */
export const handleSecretsPut = async (
  name: string,
  options: SecretsPutOptions,
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    assertSecretName(name);
    if (!(SECRET_KINDS as readonly string[]).includes(options.kind)) {
      throw new Error(`--kind is one of ${SECRET_KINDS.join(", ")}.`);
    }
    const { kind } = options;
    // No key to store: the sign-in that issues one is `secrets issue`'s.
    if (isIssuedKind(kind) && !hasValueFlags(options)) {
      throw new Error(
        `secrets put stores ${kind === "asc-api-key" ? "an" : "a"} ${kind} you have: ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}. To sign in and have Hot Updater issue one, run \`${credentialLoginCommand(kind, name)}\` in a terminal.`,
      );
    }
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets } = await loadConfig(null);
    const cwd = getCwd();

    const value = await readSecretValue(options);
    // Masked before it is sent, so no failure can print it.
    registerCredentialValue(value);
    // Always set: an adapter that stores nothing stores in `localSecrets()`'s store.
    await secrets.set!(name, value, { cwd });
    p.log.message(
      ui.block("Secret stored", [
        ui.kv("Name", name),
        ui.kv("Kind", options.kind),
        ui.kv("In", describeStoredSecret(secrets, name)),
      ]),
    );
  });
};

/** How `secrets issue` names each kind, its sign-in, and its old key. */
const ISSUERS: Readonly<
  Record<
    IssuedCredentialKind,
    {
      readonly label: string;
      readonly account: string;
      /** Whose session the sign-in opens, and Hot Updater keeps none of. */
      readonly session: string;
      readonly ensure: typeof ensureAscApiKey | typeof ensurePlayServiceAccount;
    }
  >
> = {
  "asc-api-key": {
    label: "App Store Connect API key",
    account: "Apple Account",
    session: "Apple",
    ensure: ensureAscApiKey,
  },
  "play-service-account": {
    label: "Play service account",
    account: "Google Account",
    session: "Google",
    ensure: ensurePlayServiceAccount,
  },
};

/** The key a credential's JSON value names, when it is readable. */
interface HeldKey {
  /** The rows that name it, such as its key ID. */
  readonly rows: readonly string[];
  /** Where to revoke it, and how to find it there. */
  readonly revoke: string;
}

const stringField = (fields: Record<string, unknown>, field: string) => {
  const value = fields[field];
  return typeof value === "string" && value ? value : undefined;
};

const parseFields = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The key an App Store Connect key's `keyId`, or a service account's
 * `client_email`, `private_key_id`, and `project_id`, name, read from the
 * fields of its JSON value; nothing for a value without them.
 */
const describeHeldKey = (
  kind: IssuedCredentialKind,
  fields: Record<string, unknown> | undefined,
): HeldKey | undefined => {
  if (!fields) return undefined;
  if (kind === "asc-api-key") {
    const keyId = stringField(fields, "keyId");
    if (!keyId) return undefined;
    return {
      rows: [ui.kv("Key ID", keyId)],
      revoke: `Revoke ${keyId} at ${ASC_INTEGRATIONS_URL} (Team Keys)`,
    };
  }
  const email = stringField(fields, "client_email");
  if (!email) return undefined;
  const keyId = stringField(fields, "private_key_id");
  const projectId = stringField(fields, "project_id");
  return {
    rows: [
      ui.kv("Service account", email),
      ...(keyId ? [ui.kv("Key ID", keyId)] : []),
    ],
    revoke: `Delete ${keyId ? `the key ${keyId}` : "its old key"} under the service account ${email}'s keys${projectId ? ` at ${serviceAccountKeysUrl(projectId)}` : " in Google Cloud"}`,
  };
};

/**
 * The fields of the key an environment override sets: the App Store
 * Connect key's ID, or the service account's JSON, inline or in its file.
 */
const readOverrideFields = async (
  kind: IssuedCredentialKind,
  env: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | undefined> => {
  if (kind === "asc-api-key") {
    const keyId = getHotUpdaterEnvValue(env, "HOT_UPDATER_ASC_KEY_ID");
    return keyId ? { keyId } : undefined;
  }
  const json = getHotUpdaterEnvValue(
    env,
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
  );
  if (json) {
    registerCredentialValue(json);
    return parseFields(json);
  }
  const file = getHotUpdaterEnvValue(
    env,
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
  );
  if (!file) return undefined;
  const contents = await fs
    .readFile(path.resolve(getCwd(), file), "utf-8")
    .catch(() => undefined);
  if (contents === undefined) return undefined;
  registerCredentialValue(contents);
  return parseFields(contents);
};

const listNames = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

export interface SecretsIssueOptions {
  /** Issue a new key even when one is stored, which stays valid. */
  readonly replace?: boolean;
}

/**
 * `secrets issue`, and its shortcuts `apple login` and `google-play login`:
 * signs in, at a terminal, and stores the key Hot Updater
 * issues as `name` through the config's `secrets` adapter, as builds do
 * when theirs is missing: an App Store Connect API key after an Apple
 * Account sign-in, a Play service account after a Google one. Without an
 * adapter that stores values, the key goes to `localSecrets()`'s store,
 * which builds here read.
 *
 * - In CI or without a terminal, it refuses before anything else, naming
 *   the command to run in one and `secrets put`, which stores a key you
 *   have.
 * - A key the per-field environment variables set, such as
 *   `HOT_UPDATER_ASC_KEY_ID`, is kept, and builds read it before any
 *   adapter: `--replace` refuses, since a new key would never be used,
 *   until they are unset.
 * - A key the adapter holds is kept, without a sign-in, unless `--replace`:
 *   then a new key replaces it, and the old one, which CI may still use,
 *   is named with where to revoke it. Hot Updater never revokes it.
 * - A run that issued a key ends saying Hot Updater kept no session, only
 *   the key, and where it is.
 */
export const handleSecretsIssue = async (
  kind: IssuedCredentialKind,
  name: string = kind,
  { replace = false }: SecretsIssueOptions = {},
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    assertSecretName(name);
    if (!isIssuedKind(kind)) {
      throw new Error(`The kind is one of ${ISSUED_KINDS.join(", ")}.`);
    }
    const issuer = ISSUERS[kind];
    // A shortcut takes no --replace: the full form does.
    const issue = replace
      ? `${credentialIssueCommand(kind, name)} --replace`
      : credentialLoginCommand(kind, name);
    const reason = nonInteractiveReason();
    if (reason !== undefined) {
      throw new Error(
        `Hot Updater signs in to your ${issuer.account} to issue the ${issuer.label} only at a terminal, never ${reason}. Run \`${issue}\` in a terminal, or store a key you have with \`${credentialPutCommand(kind, name)}\`.`,
      );
    }

    // Registers the config's secrets adapter, which everything below uses.
    const { secrets } = await loadConfig(null);
    const cwd = getCwd();
    const env = await readLoadedHotUpdaterEnv(cwd);

    // The default store reads the whole value's variable before the key
    // store, so a key stored there would never be read either.
    const overrides = [
      ...CREDENTIAL_ENV_NAMES[kind].flat(),
      ...(getConfiguredAdapter(secrets) === undefined
        ? [secretVariableName(name)]
        : []),
    ].filter((variable) => getHotUpdaterEnvValue(env, variable) !== undefined);
    if (overrides.length > 0) {
      const set = `${listNames(overrides)} ${overrides.length === 1 ? "is" : "are"} set in the environment or .env.hotupdater`;
      if (replace) {
        throw new Error(
          `${set}, which builds read before any secrets adapter, so a new ${issuer.label} would never be used. Unset ${overrides.length === 1 ? "it" : "them"}, then run \`${issue}\` again.`,
        );
      }
      const held = describeHeldKey(kind, await readOverrideFields(kind, env));
      p.log.message(
        ui.block(`${issuer.label} set by the environment`, [
          ui.kv("From", listNames(overrides)),
          ...(held?.rows ?? []),
          `    Builds use it before any secrets adapter, so Hot Updater issues no key. To issue one, unset ${overrides.length === 1 ? "it" : "them"} in the environment and .env.hotupdater, then run \`${credentialIssueCommand(kind, name)}\`.`,
        ]),
      );
      return;
    }

    const stored = (await secrets.get([name], { cwd }))[name] || undefined;
    // Masked before anything can print it: only its IDs are named.
    if (stored !== undefined) registerCredentialValue(stored);
    const previous =
      stored === undefined
        ? undefined
        : describeHeldKey(kind, parseFields(stored));
    if (stored !== undefined && !replace) {
      p.log.message(
        ui.block(`${issuer.label} already stored`, [
          ui.kv("Name", name),
          ui.kv("In", describeSecret(secrets, name)),
          ...(previous?.rows ?? []),
          `    Builds use it, so Hot Updater issues no key. To issue a new one, run \`${credentialIssueCommand(kind, name)} --replace\`.`,
        ]),
      );
      return;
    }

    // A cancelled prompt throws, and is reported as the failure it is.
    const result = await issuer.ensure({
      name,
      env,
      secrets,
      // Read above: a key is issued whatever the adapter holds now.
      replace: true,
      replacing: stored !== undefined,
    });
    if (result.status !== "issued") return;
    if (stored !== undefined) {
      p.log.warn(
        ui.block(`The old ${issuer.label} is still valid`, [
          ...(previous?.rows ?? []),
          ...[
            `Hot Updater never revokes it, as CI or a copy elsewhere, such as a GitHub Actions secret, may still use it. Once nothing does: ${previous ? previous.revoke : `revoke it where you issued it (${kind === "asc-api-key" ? ASC_INTEGRATIONS_URL : "the service account's keys in Google Cloud"})`}.`,
          ].map((line) => `    ${line}`),
        ]),
      );
    }
    // The sign-in's session ended with it: only the key remains.
    const key =
      "keyId" in result ? `key ${result.keyId}` : `a key of ${result.email}`;
    p.log.info(
      `Hot Updater kept no ${issuer.session} session: it stored ${key} as ${name} in ${result.secrets ? describeSecret(result.secrets, name) : describeStoredSecret(secrets, name)}.`,
    );
  });
};

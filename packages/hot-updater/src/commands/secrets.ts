import fs from "node:fs/promises";

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
  getSecretEnvNames,
  isSecretName,
  type IssuedCredentialKind,
  loadConfig,
  MANAGED_CLIENT_CREDENTIAL_ENV,
  nonInteractiveReason,
  p,
  readLoadedHotUpdaterEnv,
  readSecretWithSource,
  registerCredentialValue,
  secretVariableName,
  storeEnvFileSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { type Row, ui } from "../utils/cli-ui";
import { androidKeystoreValue } from "../utils/native/androidKeystore";
import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { importKeystore } from "../utils/native/importKeystore";
import {
  GOOGLE_PLAY_GUIDE_URL,
  parseServiceAccountKey,
} from "../utils/native/playServiceAccount";
import { storeCredential } from "../utils/native/storeCredential";
import { readTypedPath } from "../utils/typedPath";

/** The kinds `secrets put` stores, as `secret:` references resolve them. */
export const SECRET_KINDS = [
  "asc-api-key",
  "android-keystore",
  "play-service-account",
] as const satisfies readonly CredentialKind[];

/** The kinds `secrets issue` issues after a sign-in. */
export const ISSUED_KINDS = [
  "asc-api-key",
] as const satisfies readonly IssuedCredentialKind[];

/** Runs `run`, printing a failure and setting exit code 1; whether it succeeded. */
export const reportFailure = async (
  run: () => Promise<void>,
): Promise<boolean> => {
  try {
    await run();
    return true;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
};

export interface SecretsPutOptions {
  /** What the secret holds; the name, when it is a kind, by default. */
  readonly kind?: CredentialKind;
  /** The kind's file, as `secrets put <name> <file>` takes it. */
  readonly file?: string;
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

type ValueFlag = Exclude<keyof SecretsPutOptions, "kind" | "file">;

/** Options with the kind they store, and the file as its flag. */
type PutValues = Omit<SecretsPutOptions, "kind" | "file"> & {
  readonly kind: CredentialKind;
};

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

/** The flag `secrets put <name> <file>` passes its file as, by kind. */
const FILE_FLAGS: Readonly<Record<CredentialKind, ValueFlag>> = {
  "asc-api-key": "p8",
  "android-keystore": "keystore",
  "play-service-account": "serviceAccount",
};

const readFile = async (file: string, flag: string) => {
  try {
    return await fs.readFile(readTypedPath(file));
  } catch {
    throw new Error(`Can't read ${flag} ${file}.`);
  }
};

const isSecretKind = (kind: string): kind is CredentialKind =>
  (SECRET_KINDS as readonly string[]).includes(kind);

/**
 * The options with their kind, the name's when it is a kind and none is
 * given, and the file as the kind's flag, which it may not repeat.
 */
const readPutValues = (
  name: string,
  { kind: given, file, ...flags }: SecretsPutOptions,
): PutValues => {
  if (given !== undefined && !isSecretKind(given)) {
    throw new Error(`--kind is one of ${SECRET_KINDS.join(", ")}.`);
  }
  const kind = given ?? (isSecretKind(name) ? name : undefined);
  if (kind === undefined) {
    throw new Error(
      `Pass --kind: ${name} is not a kind.\n--kind is one of ${SECRET_KINDS.join(", ")}.`,
    );
  }
  if (file === undefined) return { ...flags, kind };
  const flag = FILE_FLAGS[kind];
  if (flags[flag] !== undefined) {
    throw new Error(`Pass the file once, not also ${FLAG_NAMES[flag]}.`);
  }
  return { ...flags, kind, [flag]: file };
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
const readSecretValue = async (options: PutValues): Promise<string> => {
  const { kind } = options;
  const foreign = Object.values(KIND_FLAGS)
    .flat()
    .filter(
      (flag) => !KIND_FLAGS[kind].includes(flag) && options[flag] !== undefined,
    );
  if (foreign.length > 0) {
    throw new Error(
      `${kind} takes no ${[...new Set(foreign)].map((flag) => FLAG_NAMES[flag]).join(", ")}.\nIt takes ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}.`,
    );
  }
  const required = (flag: ValueFlag) => {
    const value = options[flag];
    if (!value) throw new Error(`${kind} needs ${FLAG_NAMES[flag]}.`);
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
      const keystore = await readFile(required("keystore"), "--keystore");
      const keyAlias = required("keyAlias");
      return androidKeystoreValue({
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
      const file = required("serviceAccount");
      const text = (await readFile(file, "the key")).toString("utf-8");
      return parseServiceAccountKey(text, file).json;
    }
  }
};

/** Whether `secrets put` was given any part of a value to store. */
const hasValueFlags = (options: PutValues) =>
  Object.values(KIND_FLAGS)
    .flat()
    .some((flag) => options[flag] !== undefined);

const isIssuedKind = (kind: string): kind is IssuedCredentialKind =>
  (ISSUED_KINDS as readonly string[]).includes(kind);

export const assertSecretName = (name: string) => {
  if (!isSecretName(name)) {
    throw new Error(
      `"${name}" is not a secret name.\nUse up to 64 letters, digits, ".", "_", "-"; start with a letter or digit.`,
    );
  }
};

export const listNames = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

/** The variables `secrets put` reads a keystore's passwords from. */
const PASSWORD_INPUTS: ReadonlySet<string> = new Set([
  "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
  "HOT_UPDATER_ANDROID_KEY_PASSWORD",
]);

/**
 * The environment variables set, in `process.env` or `.env.hotupdater`, that
 * builds read for `name` before what the CLI stores: the kind's per-field
 * overrides, and with `localSecrets()`, the whole value's variable, which it
 * reads before its files.
 */
export const environmentOverrides = (
  kind: CredentialKind,
  name: string,
  secrets: SecretsAdapter,
  env: Readonly<Record<string, string>>,
) =>
  [
    ...CREDENTIAL_ENV_NAMES[kind].flat(),
    ...(getConfiguredAdapter(secrets) === undefined
      ? [secretVariableName(name)]
      : []),
  ].filter((variable) => getHotUpdaterEnvValue(env, variable) !== undefined);

/**
 * `secrets put`: stores a build credential you have as `name` through the
 * config's `secrets` adapter, or `localSecrets()` by default, as one JSON
 * value that `secret:<name>` resolves, and reads it back exactly. The
 * kind defaults to the name, and `<file>` is the kind's file: a service
 * account's JSON key, checked to be one, or a keystore, whose alias and
 * passwords a terminal asks for without `--key-alias`. It never signs in
 * or calls Google Play: `secrets issue` signs in, doctor checks access.
 */
export const handleSecretsPut = async (
  name: string,
  given: SecretsPutOptions,
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    assertSecretName(name);
    const options = readPutValues(name, given);
    const { kind } = options;
    // No key to store: the sign-in that issues one is `secrets issue`'s.
    if (isIssuedKind(kind) && !hasValueFlags(options)) {
      throw new Error(
        `secrets put needs ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}.\n${ui.withCommand("To issue a new key, run", credentialLoginCommand(kind, name))}`,
      );
    }
    if (kind === "play-service-account" && !options.serviceAccount) {
      throw new Error(
        `${ui.withCommand("secrets put needs the JSON key file:", credentialPutCommand(kind, name))}\n${GOOGLE_PLAY_GUIDE_URL}`,
      );
    }
    if (kind === "android-keystore" && !options.keystore) {
      throw new Error(
        `${ui.withCommand("secrets put needs the keystore file:", credentialPutCommand(kind, name))}\n${ui.withCommand("To create a new key, run", credentialIssueCommand(kind, name))}`,
      );
    }
    // The alias and passwords of a keystore are asked at a terminal only.
    const asksKeystore = kind === "android-keystore" && !options.keyAlias;
    const reason = nonInteractiveReason();
    if (asksKeystore && reason !== undefined) {
      throw new Error(
        `Can't ask for the keystore's passwords ${reason}: pass --key-alias.`,
      );
    }
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets } = await loadConfig(null);
    const cwd = getCwd();
    // The keystore's passwords are this command's input, not an override.
    const overrides = environmentOverrides(
      kind,
      name,
      secrets,
      await readLoadedHotUpdaterEnv(cwd),
    ).filter((variable) => !PASSWORD_INPUTS.has(variable));
    if (overrides.length > 0) {
      throw new Error(
        `The environment or .env.hotupdater overrides ${kind}.\nUnset ${listNames(overrides)}.`,
      );
    }
    if (asksKeystore) {
      await importKeystore({ secrets, name, file: options.keystore! });
      return;
    }
    const value = await readSecretValue(options);
    await storeCredential(secrets, name, value);
    const email =
      kind === "play-service-account"
        ? (JSON.parse(value) as { client_email: string }).client_email
        : undefined;
    p.log.success(
      ui.block("Secret stored", [
        ui.kv("Name", name),
        ui.kv("Kind", kind),
        email && ui.kv("Service account", email),
        ui.kv("Source", ui.fitPath(describeStoredSecret(secrets, name))),
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
    }
  >
> = {
  "asc-api-key": {
    label: "App Store Connect API key",
    account: "Apple Account",
  },
};

/** The key a credential's JSON value names, when it is readable. */
interface HeldKey {
  /** The rows that name it, such as its key ID. */
  readonly rows: readonly Row[];
  /** Where to revoke it. */
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
 * The key an App Store Connect key's `keyId` names, read from the fields
 * of its JSON value; nothing for a value without one.
 */
const describeHeldKey = (
  fields: Record<string, unknown> | undefined,
): HeldKey | undefined => {
  const keyId = fields && stringField(fields, "keyId");
  if (!keyId) return undefined;
  return { rows: [ui.kv("Key ID", keyId)], revoke: ASC_INTEGRATIONS_URL };
};

/** The fields of the key an environment override sets: its key ID. */
const readOverrideFields = (
  env: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined => {
  const keyId = getHotUpdaterEnvValue(env, "HOT_UPDATER_ASC_KEY_ID");
  return keyId ? { keyId } : undefined;
};

/**
 * The row that says a configured adapter lacks `name`, which an
 * environment override hides on this machine; nothing for `localSecrets()`
 * or an adapter that holds it.
 */
const describeAdapterGap = async (
  secrets: SecretsAdapter,
  name: string,
  cwd: string,
): Promise<Row | undefined> => {
  const configured = getConfiguredAdapter(secrets);
  if (!configured) return undefined;
  const where = describeSecret(configured, name);
  try {
    const held = (await configured.get([name], { cwd }))[name];
    return held ? undefined : ui.kv("Adapter", `none in ${ui.fitPath(where)}`);
  } catch (error) {
    return ui.kv(
      "Adapter",
      `can't read ${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface SecretsIssueOptions {
  /** Issue a new key even when one is stored, which stays valid. */
  readonly replace?: boolean;
}

/**
 * `secrets issue asc-api-key`, and its shortcut `apple login`: signs in,
 * at a terminal, and stores the App Store Connect API key Hot Updater
 * issues as `name` through the config's `secrets` adapter, as builds do
 * when theirs is missing.
 *
 * - A key the per-field environment variables set, such as
 *   `HOT_UPDATER_ASC_KEY_ID`, is kept, and builds read it before any
 *   adapter: `--replace` refuses, since a new key would never be used,
 *   until they are unset. A configured adapter that lacks `name` is named,
 *   since a teammate without the variables finds nothing.
 * - A key the adapter holds is kept, without a sign-in, unless `--replace`:
 *   then a new key replaces it, and the old one, which CI may still use,
 *   is named with where to revoke it. Hot Updater never revokes it.
 * - Only then, when it has to sign in, does it need a terminal: in CI or
 *   without one, it refuses, naming the command to run in one and
 *   `secrets put`, which stores a key you have.
 * - A run that issued a key ends with the stored key's ID and where it is.
 *
 * Answers whether the key is ready: issued, kept, or set by the environment.
 */
export const handleSecretsIssue = async (
  kind: IssuedCredentialKind,
  name: string = kind,
  { replace = false }: SecretsIssueOptions = {},
): Promise<boolean> => {
  printBanner();
  return reportFailure(async () => {
    assertSecretName(name);
    if (!isIssuedKind(kind)) {
      throw new Error(`The kind is one of ${ISSUED_KINDS.join(", ")}.`);
    }
    const issuer = ISSUERS[kind];

    // Registers the config's secrets adapter, which everything below uses.
    const { secrets } = await loadConfig(null);
    const cwd = getCwd();
    const env = await readLoadedHotUpdaterEnv(cwd);

    const overrides = environmentOverrides(kind, name, secrets, env);
    if (overrides.length > 0) {
      if (replace) {
        throw new Error(
          `The environment or .env.hotupdater overrides ${kind}.\nUnset ${listNames(overrides)}.`,
        );
      }
      const held = describeHeldKey(readOverrideFields(env));
      p.log.step(
        ui.block(`${issuer.label} set by the environment`, [
          ...(held?.rows ?? []),
          ui.kv("Source", listNames(overrides)),
          await describeAdapterGap(secrets, name, cwd),
        ]),
      );
      return;
    }

    const found = await readSecretWithSource(secrets, name, cwd);
    const stored = found?.value;
    // Masked before anything can print it: only its IDs are named.
    if (stored !== undefined) registerCredentialValue(stored);
    const previous =
      stored === undefined ? undefined : describeHeldKey(parseFields(stored));
    if (found !== undefined && !replace) {
      p.log.step(
        ui.block(`${issuer.label} already stored`, [
          name !== kind && ui.kv("Name", name),
          ...(previous?.rows ?? []),
          ui.kv("Source", ui.fitPath(found.source)),
        ]),
      );
      return;
    }

    // Only a sign-in needs a terminal: a key already held is reported
    // above, in CI too.
    const reason = nonInteractiveReason();
    if (reason !== undefined) {
      // A shortcut takes no --replace: the full form does.
      const issue = replace
        ? `${credentialIssueCommand(kind, name)} --replace`
        : credentialLoginCommand(kind, name);
      throw new Error(
        [
          `Can't sign in to your ${issuer.account} ${reason}.`,
          ui.withCommand("Run in a terminal:", issue),
          ui.withCommand(
            "Or store a key you have:",
            "npx hot-updater secrets put --help",
          ),
        ].join("\n"),
      );
    }

    // A cancelled prompt throws, and is reported as the failure it is.
    const request = {
      name,
      env,
      secrets,
      // Read above: a key is issued whatever the adapter holds now.
      replace: true,
      replacing: stored !== undefined,
    };
    const result = await ensureAscApiKey(request);
    if (result.status !== "issued" || stored === undefined) return;
    // Never revoked: CI or a copy elsewhere may still use it.
    p.log.warn(
      ui.block(`The old ${issuer.label} is still valid`, [
        ...(previous?.rows ?? []),
        ui.kv("Revoke", previous?.revoke ?? ASC_INTEGRATIONS_URL),
      ]),
    );
  });
};

/** The env file `secrets import` reads without one given. */
const DEFAULT_IMPORT_FILE = ".env.hotupdater";

/**
 * `secrets import [env-file]`: stores the credentials hot-updater.config.ts
 * reads with `secretEnv`, and the app's API key, from `envFile`,
 * `.env.hotupdater` by default, through the config's team `secrets`
 * adapter, and reads them back. Only the file is read, never the
 * environment. It deletes nothing: where the file is loaded, its lines go
 * on overriding the adapter.
 */
export const handleSecretsImport = async (envFile?: string): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    const config = await loadConfig(null);
    const adapter = getConfiguredAdapter(config.secrets);
    if (adapter === undefined) {
      throw new Error(
        "hot-updater.config.ts sets no secrets adapter.\nSet secrets to a team store first.",
      );
    }
    const file = envFile ?? DEFAULT_IMPORT_FILE;
    // A config with no secretEnv, such as Firebase's, still shares the
    // app's API key.
    const names = [...getSecretEnvNames(config), MANAGED_CLIENT_CREDENTIAL_ENV];
    const stored = await storeEnvFileSecrets(adapter, names, getCwd(), envFile);
    if (stored.length === 0) {
      throw new Error([`${file} sets none of these:`, ...names].join("\n"));
    }
    p.log.success(
      ui.block(`Stored in the ${adapter.name} secrets adapter`, stored),
    );
    p.log.info(
      [
        `${file} still sets them where it is loaded, over the adapter.`,
        "Delete those lines to read them from the adapter.",
      ].join("\n"),
    );
  });
};

import fs from "node:fs/promises";
import path from "node:path";

import { ASC_INTEGRATIONS_URL } from "@hot-updater/apple-helper";
import {
  CREDENTIAL_ENV_NAMES,
  type CredentialKind,
  credentialIssueCommand,
  credentialLoginCommand,
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
    throw new Error(`Can't read ${flag} ${file}.`);
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
 * value that `secret:<name>` resolves. It never signs in: `secrets issue`
 * does.
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
        `secrets put needs ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}.\n${ui.withCommand("To issue a new key, run", credentialLoginCommand(kind, name))}`,
      );
    }
    if (kind === "android-keystore" && !hasValueFlags(options)) {
      throw new Error(
        `secrets put needs ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}.\n${ui.withCommand("To create a new key, run", credentialIssueCommand(kind, name))}`,
      );
    }
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets } = await loadConfig(null);
    const cwd = getCwd();
    // The keystore's passwords are this command's input, not an override.
    const overrides = environmentOverrides(
      options.kind,
      name,
      secrets,
      await readLoadedHotUpdaterEnv(cwd),
    ).filter((variable) => !PASSWORD_INPUTS.has(variable));
    if (overrides.length > 0) {
      throw new Error(
        `The environment or .env.hotupdater overrides ${options.kind}.\nUnset ${listNames(overrides)}.`,
      );
    }
    const value = await readSecretValue(options);
    // Masked before it is sent, so no failure can print it.
    registerCredentialValue(value);
    await secrets.set(name, value, { cwd });
    p.log.success(
      ui.block("Secret stored", [
        ui.kv("Name", name),
        ui.kv("Kind", options.kind),
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
  "play-service-account": {
    label: "Play service account",
    account: "Google Account",
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
    return { rows: [ui.kv("Key ID", keyId)], revoke: ASC_INTEGRATIONS_URL };
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
    revoke: projectId
      ? serviceAccountKeysUrl(projectId)
      : "Google Cloud, under the service account's keys",
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
 * `secrets issue`, and its shortcuts `apple login` and `google-play login`:
 * signs in, at a terminal, and stores the key Hot Updater
 * issues as `name` through the config's `secrets` adapter, as builds do
 * when theirs is missing: an App Store Connect API key after an Apple
 * Account sign-in, a Play service account after a Google one.
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
    const { secrets, nativeBuild } = await loadConfig(null);
    const cwd = getCwd();
    const env = await readLoadedHotUpdaterEnv(cwd);

    const overrides = environmentOverrides(kind, name, secrets, env);
    if (overrides.length > 0) {
      if (replace) {
        throw new Error(
          `The environment or .env.hotupdater overrides ${kind}.\nUnset ${listNames(overrides)}.`,
        );
      }
      const held = describeHeldKey(kind, await readOverrideFields(kind, env));
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
      stored === undefined
        ? undefined
        : describeHeldKey(kind, parseFields(stored));
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
    const result =
      kind === "play-service-account"
        ? await ensurePlayServiceAccount({
            ...request,
            // A scheme's application ID defaults to its package name.
            packageNames: Object.values(nativeBuild?.android ?? {}).flatMap(
              (scheme) =>
                scheme ? [scheme.applicationId ?? scheme.packageName] : [],
            ),
          })
        : await ensureAscApiKey(request);
    if (result.status !== "issued" || stored === undefined) return;
    // Never revoked: CI or a copy elsewhere may still use it.
    p.log.warn(
      ui.block(`The old ${issuer.label} is still valid`, [
        ...(previous?.rows ?? []),
        ui.kv(
          "Revoke",
          previous?.revoke ??
            (kind === "asc-api-key"
              ? ASC_INTEGRATIONS_URL
              : "Google Cloud, under the service account's keys"),
        ),
      ]),
    );
  });
};

/**
 * `secrets import`: stores the credentials hot-updater.config.ts reads with
 * `secretEnv`, and the app's API key, from `.env.hotupdater` through the
 * config's team `secrets` adapter, and reads them back. It deletes nothing:
 * the file's lines go on overriding the adapter on this machine.
 */
export const handleSecretsImport = async (): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    const config = await loadConfig(null);
    const adapter = getConfiguredAdapter(config.secrets);
    if (adapter === undefined) {
      throw new Error(
        "hot-updater.config.ts sets no secrets adapter, so .env.hotupdater is already where secrets are read.\nSet secrets to a team store first.",
      );
    }
    const secretEnvNames = getSecretEnvNames(config);
    if (secretEnvNames.length === 0) {
      throw new Error(
        `hot-updater.config.ts reads no credential with secretEnv, so nothing would read them from ${adapter.name}.\nRead them with secretEnv first: ${SECRET_ENV_DOCS_URL}`,
      );
    }
    const names = [...secretEnvNames, MANAGED_CLIENT_CREDENTIAL_ENV];
    const stored = await storeEnvFileSecrets(adapter, names, getCwd());
    if (stored.length === 0) {
      throw new Error(`.env.hotupdater sets none of ${listNames(names)}.`);
    }
    p.log.success(
      `Stored ${listNames(stored)} in the ${adapter.name} secrets adapter.`,
    );
    p.log.info(
      ".env.hotupdater still sets them: delete those lines, or keep them to override the adapter here.",
    );
  });
};

const SECRET_ENV_DOCS_URL =
  "https://hot-updater.dev/docs/concepts/secrets#deploy-credentials-with-secretenv";

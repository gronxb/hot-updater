import {
  bundleSigningPutCommand,
  CREDENTIAL_ENV_NAMES,
  type ConfigResponse,
  type CredentialKind,
  credentialStoreCommand,
  describeMissingSecret,
  displayWidth,
  fitMessage,
  formatCommand,
  getConfiguredAdapter,
  getHotUpdaterEnvValue,
  isSecretRef,
  MESSAGE_WIDTH,
  readBundleSigningState,
  readLoadedHotUpdaterEnv,
  secretVariableName,
} from "@hot-updater/cli-tools";

import {
  findKeytool,
  KeystoreRefusedError,
  parseAndroidKeystoreValue,
  type RunKeytool,
  verifyKeystore,
} from "../../utils/native/androidKeystore";
import {
  resolvesAscApiKey,
  signsWithKeystore,
} from "../../utils/native/signingCredentials";

/** Where a build reads one `secret("<name>")` the config references. */
export interface SecretReferenceStatus {
  readonly name: string;
  /** The config fields that reference it, such as `signing.privateKey`. */
  readonly fields: readonly string[];
  /**
   * Whether a build or a deploy reads it: an iOS device scheme's
   * `signing.ascApiKey`, a release variant's `signing.keystore`, or the
   * bundle signing key while signing is on. Missing, it fails doctor; a
   * simulator scheme, a debug variant, or `enabled: false` reads nothing.
   */
  readonly required: boolean;
  /**
   * Set when it is required and missing: what is missing, and the command
   * that imports the existing key, never one that creates another.
   */
  readonly message?: string;
  /**
   * `environment`: an override in the environment or `.env.hotupdater`,
   * read before the adapter; `adapter`: the `secrets` adapter holds it;
   * `missing`: neither. Undefined when the adapter can't be read.
   */
  readonly source?: "environment" | "adapter" | "missing";
  /** Whether the adapter holds it too; undefined when it can't be read. */
  readonly inAdapter?: boolean;
  /**
   * For an upload keystore the adapter holds, what its stored passwords
   * don't open, as Gradle's signing reads it. Unchecked without a JDK.
   */
  readonly refused?: string;
}

/**
 * A warning about the `secret()`s, in the shape of doctor's other issues:
 * the names that are missing where doctor doesn't fail for it. Its message
 * says what is wrong and its resolution what to do, as people read them.
 */
export interface SecretsIssue {
  readonly type: "warning";
  /**
   * `SECRETS_MISSING_UNUSED`: build credentials no build reads, such as a
   * simulator scheme's or a debug variant's; `DEPLOY_SECRETS_MISSING`: names
   * an adapter's `secret()` reads, which a teammate may store.
   */
  readonly code: "SECRETS_MISSING_UNUSED" | "DEPLOY_SECRETS_MISSING";
  readonly names: readonly string[];
  readonly message: string;
  readonly resolution: string;
}

/** `a`, `a and b`, `a, b, and c`. */
export const listNames = (names: readonly string[]) =>
  names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

/**
 * `head` and `tail` on one line when they fit, else each on its own: a
 * long name, such as a variable, never leaves a word of the sentence alone.
 */
export const headAndTail = (head: string, tail: string): string[] =>
  displayWidth(`${head} ${tail}`) <= MESSAGE_WIDTH
    ? [`${head} ${tail}`]
    : [head, tail];

/**
 * The lines that say `names` are missing, as a command that reads them
 * says it: not in the team `adapter`, or not on this machine without one.
 */
export const missingNamesLines = (
  names: readonly string[],
  adapter: string | undefined,
): string[] =>
  headAndTail(
    listNames(names),
    `${names.length === 1 ? "isn't" : "aren't"} ${adapter === undefined ? "on this machine" : `in the ${adapter} secrets adapter`}.`,
  );

/**
 * The warning for missing names that nothing reads, if any: each with the
 * command that stores it, as the error for a name a build reads names it.
 */
export const missingUnusedIssue = (
  missing: readonly { readonly name: string; readonly command: string }[],
  adapter: string | undefined,
): SecretsIssue | undefined => {
  if (missing.length === 0) return undefined;
  const names = missing.map(({ name }) => name);
  const it = names.length === 1 ? "it" : "them";
  return {
    type: "warning",
    code: "SECRETS_MISSING_UNUSED",
    names,
    message: fitMessage([
      ...missingNamesLines(names, adapter),
      `No build or deploy reads ${it} yet, so nothing fails.`,
    ]),
    resolution: [
      fitMessage([`Store ${it} before a build or a deploy reads ${it}:`]),
      ...missing.map(({ command }) => formatCommand(command)),
    ].join("\n"),
  };
};

export interface SecretsStatus {
  /** The `secrets` adapter's name, `localSecrets` when the config sets none. */
  readonly adapter: string;
  readonly references: readonly SecretReferenceStatus[];
  /** Why the adapter couldn't be read. */
  readonly error?: string;
  /** The warnings: a missing name that no build reads. */
  readonly issues: readonly SecretsIssue[];
}

interface Reference {
  readonly field: string;
  readonly name: string;
  readonly required: boolean;
  readonly kind?: CredentialKind;
}

const referencedName = (reference: unknown): string | undefined =>
  isSecretRef(reference) ? reference.name : undefined;

/** Every build credential's `secret("<name>")` in the config. */
const collectReferences = (config: ConfigResponse): Reference[] => {
  const references: Reference[] = [];
  const add = (
    field: string,
    reference: unknown,
    required: boolean,
    kind?: CredentialKind,
  ) => {
    const name = referencedName(reference);
    if (name) {
      references.push({ field, name, required, ...(kind ? { kind } : {}) });
    }
  };
  for (const [scheme, ios] of Object.entries(config.nativeBuild?.ios ?? {})) {
    add(
      `nativeBuild.ios.${scheme}.signing.ascApiKey`,
      ios?.signing?.ascApiKey,
      resolvesAscApiKey(ios),
      "asc-api-key",
    );
  }
  for (const [scheme, android] of Object.entries(
    config.nativeBuild?.android ?? {},
  )) {
    add(
      `nativeBuild.android.${scheme}.signing.keystore`,
      android?.signing?.keystore,
      signsWithKeystore(android),
      "android-keystore",
    );
  }
  const signing: unknown = config.signing;
  const signs = readBundleSigningState(signing).status === "on";
  if (isSecretRef(signing)) {
    add("signing", signing, signs);
  } else if (
    signing &&
    typeof signing === "object" &&
    "privateKey" in signing
  ) {
    add("signing.privateKey", signing.privateKey, signs);
  }
  return references;
};

/**
 * The command that stores `name`, by what reads it: an upload keystore or
 * a signing key is imported, as a store or a shipped app may already trust
 * it; an App Store Connect API key is issued after a sign-in.
 */
const storeCommand = (
  name: string,
  references: readonly Reference[],
): string => {
  const kind = kindOf(references);
  return kind === undefined
    ? bundleSigningPutCommand(name)
    : credentialStoreCommand(kind, name);
};

/** What a name holds, by the first reference that says. */
const kindOf = (references: readonly Reference[]) =>
  references.find((reference) => reference.kind)?.kind;

/** Why a build or a deploy stops without `name`, and how to store it. */
const describeMissing = (
  secrets: ConfigResponse["secrets"],
  name: string,
  references: readonly Reference[],
): string =>
  describeMissingSecret(secrets, name, {
    ...(kindOf(references) === "asc-api-key"
      ? { action: "sign in to store one" }
      : {}),
    command: storeCommand(name, references),
  });

/** The `secret()`s a build or a deploy reads that resolve nowhere. */
export const missingRequiredSecrets = (
  status: SecretsStatus | undefined,
): SecretReferenceStatus[] =>
  (status?.references ?? []).filter(
    ({ required, source }) => required && source === "missing",
  );

/**
 * Where each build credential's `secret()` is read from, with one `get`
 * of every referenced name: nothing is written, and no value is kept.
 * Undefined when the config references none.
 */
export const checkSecrets = async (
  config: ConfigResponse,
  cwd: string,
): Promise<SecretsStatus | undefined> => {
  const references = collectReferences(config);
  if (references.length === 0) return undefined;

  const byName = new Map<string, Reference[]>();
  for (const reference of references) {
    byName.set(reference.name, [
      ...(byName.get(reference.name) ?? []),
      reference,
    ]);
  }
  const names = [...byName.keys()];
  const { secrets } = config;
  const local = getConfiguredAdapter(secrets) === undefined;
  const env = await readLoadedHotUpdaterEnv(cwd);
  const overridden = (name: string) =>
    [
      ...byName
        .get(name)!
        .flatMap(({ kind }) => (kind ? CREDENTIAL_ENV_NAMES[kind].flat() : [])),
      // localSecrets() reads the whole value's variable before its files.
      ...(local ? [secretVariableName(name)] : []),
    ].some((variable) => getHotUpdaterEnvValue(env, variable) !== undefined);

  let held: Readonly<Record<string, string | undefined>> | undefined;
  let error: string | undefined;
  try {
    held = await secrets.get(names, { cwd });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  // Builds sign with the keystore the adapter holds: its passwords are
  // checked as Gradle's signing reads them, with a JDK when there is one.
  let keytool: Promise<RunKeytool | undefined> | undefined;
  const refusals = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const value = held?.[name];
      if (
        !value ||
        overridden(name) ||
        !byName.get(name)!.some(({ kind }) => kind === "android-keystore")
      ) {
        return;
      }
      const entry = parseAndroidKeystoreValue(value);
      if (!entry) return;
      keytool ??= findKeytool().catch(() => undefined);
      const run = await keytool;
      if (!run) return;
      await verifyKeystore(run, entry).catch((cause: unknown) => {
        if (cause instanceof KeystoreRefusedError) {
          refusals.set(name, cause.message);
        }
      });
    }),
  );

  const statuses = names.map((name): SecretReferenceStatus => {
    const fields = byName.get(name)!.map(({ field }) => field);
    const required = byName.get(name)!.some((reference) => reference.required);
    const environment = overridden(name);
    if (held === undefined) {
      return environment
        ? { name, fields, required, source: "environment" }
        : { name, fields, required };
    }
    const value = Object.hasOwn(held, name) ? held[name] : undefined;
    const inAdapter = typeof value === "string" && value.length > 0;
    const refused = refusals.get(name);
    const missing = required && !environment && !inAdapter;
    return {
      name,
      fields,
      required,
      source: environment ? "environment" : inAdapter ? "adapter" : "missing",
      inAdapter,
      ...(missing
        ? { message: describeMissing(secrets, name, byName.get(name)!) }
        : {}),
      ...(refused === undefined ? {} : { refused }),
    };
  });
  const unused = missingUnusedIssue(
    statuses
      .filter(({ required, source }) => !required && source === "missing")
      .map(({ name }) => ({
        name,
        command: storeCommand(name, byName.get(name)!),
      })),
    local ? undefined : secrets.name,
  );

  return {
    adapter: secrets.name,
    references: statuses,
    ...(error === undefined ? {} : { error }),
    issues: unused === undefined ? [] : [unused],
  };
};

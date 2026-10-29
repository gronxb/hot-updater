import {
  CREDENTIAL_ENV_NAMES,
  type ConfigResponse,
  type CredentialKind,
  getConfiguredAdapter,
  getHotUpdaterEnvValue,
  isSecretRef,
  readLoadedHotUpdaterEnv,
  secretVariableName,
} from "@hot-updater/cli-tools";

/** Where a build reads one `secret("<name>")` the config references. */
export interface SecretReferenceStatus {
  readonly name: string;
  /** The config fields that reference it, such as `signing.privateKey`. */
  readonly fields: readonly string[];
  /**
   * `environment`: an override in the environment or `.env.hotupdater`,
   * read before the adapter; `adapter`: the `secrets` adapter holds it;
   * `missing`: neither. Undefined when the adapter can't be read.
   */
  readonly source?: "environment" | "adapter" | "missing";
  /** Whether the adapter holds it too; undefined when it can't be read. */
  readonly inAdapter?: boolean;
}

export interface SecretsStatus {
  /** The `secrets` adapter's name, `localSecrets` when the config sets none. */
  readonly adapter: string;
  readonly references: readonly SecretReferenceStatus[];
  /** Why the adapter couldn't be read. */
  readonly error?: string;
}

interface Reference {
  readonly field: string;
  readonly name: string;
  readonly kind?: CredentialKind;
}

const referencedName = (reference: unknown): string | undefined =>
  isSecretRef(reference) ? reference.name : undefined;

/** Every build credential's `secret("<name>")` in the config. */
const collectReferences = (config: ConfigResponse): Reference[] => {
  const references: Reference[] = [];
  const add = (field: string, reference: unknown, kind?: CredentialKind) => {
    const name = referencedName(reference);
    if (name) references.push({ field, name, ...(kind ? { kind } : {}) });
  };
  for (const [scheme, ios] of Object.entries(config.nativeBuild?.ios ?? {})) {
    add(
      `nativeBuild.ios.${scheme}.signing.ascApiKey`,
      ios?.signing?.ascApiKey,
      "asc-api-key",
    );
  }
  for (const [scheme, android] of Object.entries(
    config.nativeBuild?.android ?? {},
  )) {
    add(
      `nativeBuild.android.${scheme}.signing.keystore`,
      android?.signing?.keystore,
      "android-keystore",
    );
  }
  const signing: unknown = config.signing;
  if (isSecretRef(signing)) {
    add("signing", signing);
  } else if (
    signing &&
    typeof signing === "object" &&
    "privateKey" in signing
  ) {
    add("signing.privateKey", signing.privateKey);
  }
  return references;
};

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

  return {
    adapter: secrets.name,
    references: names.map((name) => {
      const fields = byName.get(name)!.map(({ field }) => field);
      const environment = overridden(name);
      if (held === undefined) {
        return environment
          ? { name, fields, source: "environment" }
          : { name, fields };
      }
      const value = Object.hasOwn(held, name) ? held[name] : undefined;
      const inAdapter = typeof value === "string" && value.length > 0;
      return {
        name,
        fields,
        source: environment ? "environment" : inAdapter ? "adapter" : "missing",
        inAdapter,
      };
    }),
    ...(error === undefined ? {} : { error }),
  };
};

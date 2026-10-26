import fs from "node:fs/promises";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { CREDENTIAL_ENV_NAMES } from "./credentialEnvNames";
import { type CredentialFiles, createCredentialFiles } from "./credentialFiles";
import { getCwd } from "./cwd";
import { getHotUpdaterEnvValue } from "./hotUpdaterEnv";
import { registerSecretValue } from "./secretMasking";
import { describeSecret, getConfiguredSecrets } from "./secrets";

export type { CredentialFiles } from "./credentialFiles";
export { CREDENTIAL_ENV_NAMES } from "./credentialEnvNames";

/**
 * The build credentials the CLI resolves by name. Deploy credentials reach
 * the config's adapters through `secretEnv`.
 */
export interface Credentials {
  /** App Store Connect API key, for automatic signing and uploads. */
  "asc-api-key": {
    /** A 0600 temporary file or the path the user set. */
    readonly keyPath: string;
    readonly keyId: string;
    readonly issuerId: string;
  };
  /** Android release keystore, for Gradle signing. */
  "android-keystore": {
    /** A 0600 temporary file or the path the user set. */
    readonly storeFile: string;
    readonly storePassword: string;
    readonly keyAlias: string;
    readonly keyPassword: string;
  };
  /** Google Play service account, kept in memory. */
  "play-service-account": {
    readonly json: string;
  };
}

export type CredentialKind = keyof Credentials;

export interface CredentialRequest<TKind extends CredentialKind> {
  readonly kind: TKind;
  /**
   * The item's name, for a project with several items of one kind (such as
   * `widget-keystore`). Defaults to the kind. Environment overrides apply to
   * every item of a kind.
   */
  readonly name?: string;
}

/**
 * Resolves the credentials a command needs. Commands call `dispose` in a
 * `finally` (or use `withCredentialResolver`); temporary files are also
 * deleted when the process exits.
 */
export interface CredentialResolver {
  resolve<TKind extends CredentialKind>(
    request: CredentialRequest<TKind>,
  ): Promise<Credentials[TKind]>;
  /**
   * Waits for resolutions in flight, then deletes every temporary file this
   * resolver wrote. The resolver resolves nothing after it.
   */
  dispose(): Promise<void>;
}

/** Passwords are read as set: trimming would change them. */
const UNTRIMMED_ENV_NAMES = new Set<string>([
  "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
  "HOT_UPDATER_ANDROID_KEY_PASSWORD",
]);

type EnvField = readonly string[];

const describeField = ([name, alternative]: EnvField) =>
  alternative ? `${name} (or ${alternative})` : name;

const describeFields = (fields: readonly EnvField[]) => {
  const described = fields.map(describeField);
  if (described.length <= 2) {
    return described.join(" and ");
  }
  return `${described.slice(0, -1).join(", ")}, and ${described.at(-1)}`;
};

/**
 * The sentence every "credential unavailable" message ends with: the
 * environment variables that provide `kind` whatever the secrets adapter.
 */
export const credentialOverrideHint = (kind: CredentialKind): string =>
  `Or set ${describeFields(CREDENTIAL_ENV_NAMES[kind])} to provide ${kind} from the environment.`;

/**
 * The command that stores a credential of `kind` you have as `name` through
 * the config's `secrets` adapter, from its files.
 */
export const credentialPutCommand = (
  kind: CredentialKind,
  name: string = kind,
): string => {
  const put = `npx hot-updater secrets put ${name} --kind ${kind}`;
  switch (kind) {
    case "android-keystore":
      return `${put} --keystore <release.jks> --key-alias <alias>`;
    case "asc-api-key":
      return `${put} --p8 <AuthKey.p8> --key-id <id> --issuer-id <id>`;
    case "play-service-account":
      return `${put} --service-account <key.json>`;
  }
};

/** The credentials Hot Updater issues itself after a sign-in. */
export type IssuedCredentialKind = Exclude<CredentialKind, "android-keystore">;

/**
 * The command that signs in once, at a terminal, and stores the key Hot
 * Updater issues as `name`: an App Store Connect API key after an Apple
 * Account sign-in, a Play service account after a Google one.
 */
export const credentialIssueCommand = (
  kind: IssuedCredentialKind,
  name: string = kind,
): string =>
  `npx hot-updater secrets issue ${kind}${name === kind ? "" : ` ${name}`}`;

/** The command group of each issued kind's shortcut, `<group> login`. */
export const CREDENTIAL_LOGIN_GROUPS = {
  "asc-api-key": "apple",
  "play-service-account": "google-play",
} as const satisfies Record<IssuedCredentialKind, string>;

/**
 * The shortcut of `credentialIssueCommand`, the one people meet first:
 * `apple login` for an App Store Connect API key, `google-play login` for
 * a Play service account, with `name` when it is not the kind's.
 */
export const credentialLoginCommand = (
  kind: IssuedCredentialKind,
  name: string = kind,
): string =>
  `npx hot-updater ${CREDENTIAL_LOGIN_GROUPS[kind]} login${name === kind ? "" : ` ${name}`}`;

/**
 * The command that stores a missing credential of `kind` as `name`: the
 * keystore you have, or the key Hot Updater issues after a sign-in.
 */
export const credentialStoreCommand = (
  kind: CredentialKind,
  name: string = kind,
): string =>
  kind === "android-keystore"
    ? credentialPutCommand(kind, name)
    : credentialLoginCommand(kind, name);

export class CredentialUnavailableError extends Error {
  readonly kind: CredentialKind;
  /** The environment variables that can provide this credential. */
  readonly envNames: readonly string[];

  constructor(
    kind: CredentialKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialUnavailableError";
    this.kind = kind;
    this.envNames = CREDENTIAL_ENV_NAMES[kind].flat();
  }
}

type EnvValue = { readonly name: string; readonly value: string };

const readEnvField = (
  env: Readonly<Record<string, string>>,
  field: EnvField,
): EnvValue | undefined => {
  for (const name of field) {
    const value = UNTRIMMED_ENV_NAMES.has(name)
      ? (process.env[name] ?? env[name]) || undefined
      : getHotUpdaterEnvValue(env, name);
    if (value !== undefined) {
      return { name, value };
    }
  }
  return undefined;
};

const readFileField = async (
  kind: CredentialKind,
  { name, value }: EnvValue,
) => {
  const filePath = path.resolve(value);
  const isReadableFile = await fs
    .stat(filePath)
    .then(async (stats) => {
      await fs.access(filePath, fs.constants.R_OK);
      return stats.isFile();
    })
    .catch(() => false);
  if (!isReadableFile) {
    throw new CredentialUnavailableError(
      kind,
      // The value is not echoed: it may be a credential set by mistake.
      `${name} does not point to a readable file.`,
    );
  }
  return filePath;
};

const parseServiceAccount = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const fromEnv: {
  readonly [TKind in CredentialKind]: (
    values: readonly EnvValue[],
    context: { readonly files: CredentialFiles; readonly name: string },
  ) => Promise<Credentials[TKind]>;
} = {
  "asc-api-key": async ([key, keyId, issuerId], { files }) => ({
    keyPath:
      key.name === "HOT_UPDATER_ASC_KEY_PATH"
        ? await readFileField("asc-api-key", key)
        : await files.write(
            `AuthKey_${keyId.value}.p8`,
            // A PEM pasted into a one-line CI secret keeps its newlines as \n.
            key.value.includes("\n")
              ? key.value
              : key.value.replaceAll("\\n", "\n"),
          ),
    keyId: keyId.value,
    issuerId: issuerId.value,
  }),
  "android-keystore": async (
    [keystore, storePassword, keyAlias, keyPassword],
    { files, name },
  ) => {
    let storeFile: string;
    if (keystore.name === "HOT_UPDATER_ANDROID_KEYSTORE_PATH") {
      storeFile = await readFileField("android-keystore", keystore);
    } else {
      registerSecretValue(keystore.value);
      const contents = decodeBase64(keystore.value);
      if (!contents) {
        throw new CredentialUnavailableError(
          "android-keystore",
          `${keystore.name} is not a base64-encoded keystore.`,
        );
      }
      storeFile = await files.write(`${name}.keystore`, contents);
    }
    return {
      storeFile,
      storePassword: storePassword.value,
      keyAlias: keyAlias.value,
      keyPassword: keyPassword.value,
    };
  },
  "play-service-account": async ([serviceAccount]) => {
    const json =
      serviceAccount.name === "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH"
        ? await fs.readFile(
            await readFileField("play-service-account", serviceAccount),
            "utf-8",
          )
        : serviceAccount.value;
    const parsed = parseServiceAccount(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialUnavailableError(
        "play-service-account",
        `${serviceAccount.name} is not a service account JSON object.`,
      );
    }
    return { json };
  },
};

/** Fields of a service account that are no secret: its type and Google's endpoints. */
/**
 * Fields of a JSON credential that identify it rather than grant access:
 * its IDs, key alias, and a service account's email, project, type, and
 * Google's endpoints. They stay readable, as messages name them, and a
 * short one, such as the alias `release`, would mask every word it is in.
 */
const isIdentifierField = (field: string) =>
  [
    "keyId",
    "issuerId",
    "keyAlias",
    "type",
    "project_id",
    "client_email",
    "client_id",
    "private_key_id",
    "universe_domain",
  ].includes(field) ||
  field.endsWith("_uri") ||
  field.endsWith("_url");

const registerJsonSecrets = (
  value: string,
  fields: Readonly<Record<string, unknown>>,
) => {
  registerSecretValue(value);
  for (const [field, entry] of Object.entries(fields)) {
    if (typeof entry === "string" && !isIdentifierField(field)) {
      registerSecretValue(entry);
    }
  }
};

/**
 * Masks a credential's JSON value in the CLI's output: the whole value, and
 * each field but those that identify it, such as `keyId` and `keyAlias`,
 * so a password or a key a log prints alone stays masked. A value that is
 * no JSON object is masked whole.
 */
export const registerCredentialValue = (value: string): void => {
  const parsed = parseObject(value);
  if (parsed) registerJsonSecrets(value, parsed);
  else registerSecretValue(value);
};

const parseObject = (value: string): Record<string, unknown> | undefined => {
  const parsed = parseServiceAccount(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
};

/**
 * The fields of a JSON credential, each a non-empty string, or an error
 * naming the shape `kind` takes.
 */
const readJsonFields = <TField extends string>(
  kind: CredentialKind,
  item: string,
  value: string,
  fields: readonly TField[],
): Record<TField, string> => {
  const parsed = parseObject(value);
  const shape = `{${fields.map((field) => `"${field}"`).join(", ")}}`;
  if (!parsed) {
    throw new CredentialUnavailableError(
      kind,
      `${item} is not a JSON object: ${aKind(kind)} is one JSON value, ${shape}.`,
    );
  }
  registerJsonSecrets(value, parsed);
  const missing = fields.filter(
    (field) => typeof parsed[field] !== "string" || !parsed[field],
  );
  if (missing.length > 0) {
    throw new CredentialUnavailableError(
      kind,
      `${item} has no ${missing.join(", ")}: ${aKind(kind)} is one JSON value, ${shape}.`,
    );
  }
  return parsed as Record<TField, string>;
};

const aKind = (kind: string) =>
  `${/^[aeiou]/u.test(kind) ? "an" : "a"} ${kind}`;

/** A base64 value's bytes, or undefined when it is not base64. */
const decodeBase64 = (value: string): Buffer | undefined => {
  const base64 = value.replace(/\s/g, "");
  const contents = Buffer.from(base64, "base64");
  return contents.length > 0 &&
    contents.toString("base64").replace(/=+$/, "") === base64.replace(/=+$/, "")
    ? contents
    : undefined;
};

/**
 * Each kind from the one string a secrets adapter holds for it: a JSON
 * object for the App Store Connect key (`p8` is the PEM) and the keystore
 * (`keystore` is base64), and the service account's own JSON. File values
 * are written with `files`; every value is masked.
 */
const fromSecretValue: {
  readonly [TKind in CredentialKind]: (
    value: string,
    context: {
      readonly files: CredentialFiles;
      readonly name: string;
      readonly item: string;
    },
  ) => Promise<Credentials[TKind]>;
} = {
  "asc-api-key": async (value, { files, item }) => {
    const { keyId, issuerId, p8 } = readJsonFields("asc-api-key", item, value, [
      "keyId",
      "issuerId",
      "p8",
    ]);
    return {
      keyPath: await files.write(
        `AuthKey_${keyId}.p8`,
        p8.includes("\n") ? p8 : p8.replaceAll("\\n", "\n"),
      ),
      keyId,
      issuerId,
    };
  },
  "android-keystore": async (value, { files, name, item }) => {
    const { keystore, storePassword, keyAlias, keyPassword } = readJsonFields(
      "android-keystore",
      item,
      value,
      ["keystore", "storePassword", "keyAlias", "keyPassword"],
    );
    const contents = decodeBase64(keystore);
    if (!contents) {
      throw new CredentialUnavailableError(
        "android-keystore",
        `${item}'s keystore is not a base64-encoded keystore.`,
      );
    }
    return {
      storeFile: await files.write(`${name}.keystore`, contents),
      storePassword,
      keyAlias,
      keyPassword,
    };
  },
  "play-service-account": async (value, { item }) => {
    const parsed = parseObject(value);
    if (!parsed) {
      throw new CredentialUnavailableError(
        "play-service-account",
        `${item} is not a service account JSON object.`,
      );
    }
    registerJsonSecrets(value, parsed);
    return { json: value };
  },
};

const registerCredentialSecrets = <TKind extends CredentialKind>(
  kind: TKind,
  credential: Credentials[TKind],
) => {
  if (kind === "android-keystore") {
    const keystore = credential as Credentials["android-keystore"];
    registerSecretValue(keystore.storePassword);
    registerSecretValue(keystore.keyPassword);
  }
  if (kind === "play-service-account") {
    const { json } = credential as Credentials["play-service-account"];
    registerSecretValue(json);
    const privateKey = (
      parseServiceAccount(json) as { private_key?: unknown } | undefined
    )?.private_key;
    if (typeof privateKey === "string") {
      registerSecretValue(privateKey);
    }
  }
};

/**
 * Reads names from `secrets`, the names asked for in one turn of the event
 * loop, such as a build's credentials, in one `get`. Nothing is cached.
 */
const createSecretLoader = (
  secrets: () => SecretsAdapter,
  cwd: () => string,
) => {
  type Waiter = {
    readonly resolve: (value: string | undefined) => void;
    readonly reject: (error: unknown) => void;
  };
  let batch: Map<string, Waiter[]> | undefined;

  const flush = async (names: Map<string, Waiter[]>) => {
    try {
      const read = await secrets().get([...names.keys()], { cwd: cwd() });
      for (const [name, waiters] of names) {
        const value = Object.hasOwn(read, name) ? read[name] : undefined;
        for (const waiter of waiters) {
          waiter.resolve(
            typeof value === "string" && value ? value : undefined,
          );
        }
      }
    } catch (error) {
      for (const waiters of names.values()) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
  };

  return (name: string): Promise<string | undefined> =>
    new Promise((resolve, reject) => {
      if (batch === undefined) {
        const names = new Map<string, Waiter[]>();
        batch = names;
        setTimeout(() => {
          batch = undefined;
          void flush(names);
        }, 0);
      }
      const waiters = batch.get(name) ?? [];
      waiters.push({ resolve, reject });
      batch.set(name, waiters);
    });
};

export interface CreateCredentialResolverOptions {
  /**
   * Environment values read after `process.env`, the same lookup as
   * `getHotUpdaterEnvValue`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Where to find an item no environment override sets, or a function that
   * returns it when an item resolves, for a command whose config loads
   * after the resolver is created. Defaults to the config `loadConfig` last
   * loaded, `envSecrets()` when it sets none.
   */
  readonly secrets?: SecretsAdapter | (() => SecretsAdapter);
  /** The project directory the adapter is given. Defaults to `getCwd()`. */
  readonly cwd?: string;
}

/**
 * Resolves each item from its environment overrides when any is set, and
 * otherwise from the config's `secrets` adapter as one value named by the
 * item, so overrides never reach the store. When the adapter fails or holds
 * no such value, the error names the environment variables that can
 * provide the item instead. Nothing is cached, values are never written to
 * disk except as 0600 temporary files, are never set in `process.env`, and
 * every secret is masked in logs.
 */
export const createCredentialResolver = ({
  env = {},
  secrets,
  cwd,
}: CreateCredentialResolverOptions = {}): CredentialResolver => {
  const files = createCredentialFiles();
  const resolved = new Map<string, Promise<unknown>>();
  let disposal: Promise<void> | undefined;
  const adapter = () =>
    typeof secrets === "function"
      ? secrets()
      : (secrets ?? getConfiguredSecrets());
  const load = createSecretLoader(adapter, () => cwd ?? getCwd());

  const resolveItem = async <TKind extends CredentialKind>(
    kind: TKind,
    name: string,
  ): Promise<Credentials[TKind]> => {
    const fields: readonly EnvField[] = CREDENTIAL_ENV_NAMES[kind];
    const values = fields.map((field) => readEnvField(env, field));

    if (values.some((value) => value !== undefined)) {
      const missing = fields.filter((_, index) => !values[index]);
      if (missing.length > 0) {
        throw new CredentialUnavailableError(
          kind,
          `The environment overrides ${kind} but ${describeFields(missing)} ${missing.length === 1 ? "is" : "are"} not set.`,
        );
      }
      const credential = await fromEnv[kind](values as EnvValue[], {
        files,
        name,
      });
      registerCredentialSecrets(kind, credential);
      return credential;
    }

    const store = adapter();
    const item = name === kind ? kind : `${name} (${kind})`;
    let value: string | undefined;
    try {
      value = await load(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CredentialUnavailableError(
        kind,
        `The ${store.name} secrets adapter could not read ${item}: ${reason} ${credentialOverrideHint(kind)}`,
        { cause: error },
      );
    }
    if (value === undefined) {
      throw new CredentialUnavailableError(
        kind,
        `${item} is not in the ${store.name} secrets adapter (${describeSecret(store, name)}). Store it once with \`${credentialStoreCommand(kind, name)}\`. ${credentialOverrideHint(kind)}`,
      );
    }
    registerSecretValue(value);
    return fromSecretValue[kind](value, {
      files,
      name,
      item: `The ${store.name} secrets adapter's ${item}`,
    });
  };

  return {
    resolve: <TKind extends CredentialKind>({
      kind,
      name = kind,
    }: CredentialRequest<TKind>) => {
      if (disposal) {
        return Promise.reject(
          new Error("The credential resolver has been disposed."),
        );
      }
      const key = `${kind}\u0000${name}`;
      let pending = resolved.get(key) as
        | Promise<Credentials[TKind]>
        | undefined;
      if (!pending) {
        pending = resolveItem(kind, name);
        resolved.set(key, pending);
        pending.catch(() => resolved.delete(key));
      }
      return pending;
    },
    dispose: () => {
      disposal ??= (async () => {
        // A resolution in flight may still write a file.
        await Promise.allSettled(resolved.values());
        resolved.clear();
        await files.dispose();
      })();
      return disposal;
    },
  };
};

/**
 * Runs `run` with a credential resolver and deletes its temporary files
 * when `run` settles.
 */
export const withCredentialResolver = async <T>(
  run: (resolver: CredentialResolver) => Promise<T>,
  options?: CreateCredentialResolverOptions,
): Promise<T> => {
  const resolver = createCredentialResolver(options);
  try {
    return await run(resolver);
  } finally {
    await resolver.dispose();
  }
};

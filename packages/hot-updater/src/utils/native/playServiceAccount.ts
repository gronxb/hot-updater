import {
  GOOGLE_OAUTH_CLIENT_ENV_NAMES,
  type GoogleOAuthClient,
  type IssuedPlayServiceAccount,
  type IssuePlayServiceAccount,
  issuePlayServiceAccount,
  PLAY_CONSOLE_URL,
} from "@hot-updater/android-helper";
import {
  CREDENTIAL_ENV_NAMES,
  createVaultClient,
  getCwd,
  getHotUpdaterEnvValue,
  p,
  readLoadedHotUpdaterEnv,
  readVaultConnection,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  VaultRequestError,
} from "@hot-updater/cli-tools";
import open from "open";

import { ui } from "../cli-ui";
import { canPrompt } from "../prompt";

/** The command that signs in once, in a terminal, and stores the key. */
export const playServiceAccountSetupCommand = (name: string) =>
  `npx hot-updater secrets put ${name} --kind play-service-account`;

/**
 * Why there is no Play service account to upload with, already reported by
 * `canPrompt`, which set the exit code.
 */
export class PlayServiceAccountRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayServiceAccountRefusedError";
  }
}

export type EnsurePlayServiceAccountResult =
  /** The environment overrides the service account: nothing is looked up in the vault. */
  | { readonly status: "environment" }
  /** The vault holds the service account already: no sign-in. */
  | { readonly status: "stored"; readonly version: number }
  /** The key was issued with a Google sign-in and stored. */
  | {
      readonly status: "issued";
      readonly email: string;
      readonly version: number;
    };

/**
 * Whether the vault token may write `name` as a play-service-account, asked
 * without storing anything: the Console checks a write's scope before its
 * value, so a write of an empty value is refused with 400 when the token
 * may write it and 403 when it may not. A 403 is logged as a denied write.
 */
const assertWritable = async (client: VaultClient, name: string) => {
  try {
    await client.put({
      name,
      kind: "play-service-account",
      value: {},
      expectedVersion: 0,
    });
  } catch (error) {
    if (!(error instanceof VaultRequestError)) throw error;
    if (error.status === 400 && error.code === "invalid_request") return;
    if (error.status === 403) {
      throw new Error(
        `The vault token cannot store ${name}, which keeps the key Hot Updater issues after you sign in with Google. Use a vault token whose scope allows write on ${name} (hot-updater secrets token create --actions read,write), so you sign in only once.`,
        { cause: error },
      );
    }
    if (error.status === 404 || error.status === 405) {
      throw new Error(
        `The Console at ${client.url} does not store secrets from the CLI: upgrade it, then run this again.`,
        { cause: error },
      );
    }
    throw error;
  }
  // The Console never stores an empty value; reaching here means it did.
  throw new Error(
    `The Console at ${client.url} accepted an empty ${name}: remove it in the Console, then run this again.`,
  );
};

/**
 * Whether the vault token reads `name` back at `version`, as the build
 * resolves it. Asked after the store: before it, the Console refuses a name
 * no secret has to a token scoped by kind, which may read it once stored.
 */
const assertReadable = async (
  client: VaultClient,
  name: string,
  version: number,
) => {
  try {
    const { secrets } = await client.resolve([name]);
    if (
      secrets.some(
        (secret) =>
          secret.name === name &&
          secret.kind === "play-service-account" &&
          secret.version === version,
      )
    ) {
      return;
    }
  } catch (error) {
    if (!(error instanceof VaultRequestError && error.status === 403)) {
      throw error;
    }
  }
  throw new Error(
    `${name} is stored (v${version}), but the vault token cannot read it, which the build uploads with. Use a vault token whose scope allows read on ${name}, then run the build again: it uses the stored key without signing in.`,
  );
};

const PACKAGE_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

/** Throws `PlayServiceAccountRefusedError` for a cancelled prompt. */
const answered = <T>(answer: T | symbol): T => {
  if (p.isCancel(answer)) {
    throw new PlayServiceAccountRefusedError(
      "Setting up the Play service account was cancelled.",
    );
  }
  return answer as T;
};

/** The OAuth client `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_*` set, if any. */
const oauthClientOverride = (
  env: Readonly<Record<string, string>>,
): GoogleOAuthClient | undefined => {
  const clientId = getHotUpdaterEnvValue(
    env,
    GOOGLE_OAUTH_CLIENT_ENV_NAMES.clientId,
  );
  if (clientId === undefined) return undefined;
  const clientSecret = getHotUpdaterEnvValue(
    env,
    GOOGLE_OAUTH_CLIENT_ENV_NAMES.clientSecret,
  );
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether the Console answered a write, and so stored nothing: an
 * unanswered write or a server error may have stored it, but a locked vault
 * (503) never does.
 */
const refusedWrite = (error: unknown) =>
  error instanceof VaultRequestError &&
  error.status !== undefined &&
  (error.status < 500 || error.status === 503);

/**
 * Stores `issued` as `name`, and reads it back: the vault must list it as
 * the service account just issued. The key is deleted again only when the
 * vault does not hold it; one the vault may hold is kept, since deleting it
 * would leave the vault with a dead key, and the message says which.
 */
const storeIssued = async (
  client: VaultClient,
  name: string,
  issued: IssuedPlayServiceAccount,
): Promise<number> => {
  /** The vault's `name` when it is the key just issued, from a fresh list. */
  const listIssued = async () => {
    const listed = (await client.list()).find(
      (candidate) => candidate.name === name,
    );
    return listed?.kind === "play-service-account" &&
      listed.metadata["clientEmail"] === issued.email
      ? listed
      : undefined;
  };
  const deleteKey = async (why: string, cause: unknown): Promise<never> => {
    const revoked = await issued.revoke();
    const keys = `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${issued.projectId}`;
    throw new Error(
      [
        `The vault did not store ${name}: ${why}`,
        revoked
          ? `The key ${issued.keyId} was deleted again.`
          : `Deleting the key ${issued.keyId} failed: delete it under the service account's keys at ${keys}.`,
        `The service account ${issued.email} and its Play Console access remain, and the next run reuses them.`,
      ].join("\n"),
      { cause },
    );
  };
  const unconfirmed = (cause: unknown): never => {
    throw new Error(
      `Hot Updater could not confirm that the vault stored ${name}: ${errorText(cause)}\nThe key ${issued.keyId} is kept. Run \`npx hot-updater secrets list\`: when ${name} is listed, run the build again; when it is not, delete the key under the service account ${issued.email} in Google Cloud, then run this again.`,
      { cause },
    );
  };

  let version: number;
  try {
    version = (
      await client.put({
        name,
        kind: "play-service-account",
        value: {
          serviceAccount: Buffer.from(issued.json, "utf-8").toString("base64"),
        },
        // Never replaces a key someone stored meanwhile.
        expectedVersion: 0,
      })
    ).version;
  } catch (error) {
    if (refusedWrite(error)) return deleteKey(errorText(error), error);
    // The write may have landed: the vault's list tells.
    let held: Awaited<ReturnType<typeof listIssued>>;
    try {
      held = await listIssued();
    } catch {
      return unconfirmed(error);
    }
    if (held === undefined) return deleteKey(errorText(error), error);
    return held.version;
  }

  let held: Awaited<ReturnType<typeof listIssued>>;
  try {
    held = await listIssued();
  } catch (error) {
    return unconfirmed(error);
  }
  if (held?.version !== version) {
    return deleteKey(
      "the vault does not list it as the key just stored.",
      undefined,
    );
  }
  return version;
};

/**
 * Makes sure a Play service account named `name` exists where builds
 * resolve it, issuing one when it does not. Everything that can fail is
 * checked before any Google sign-in, in this order:
 *
 * 1. an environment override of play-service-account
 *    (`HOT_UPDATER_PLAY_SERVICE_ACCOUNT_*`) is used as it is;
 * 2. a vault secret named `name` of kind play-service-account is used as it
 *    is, so CI uploads with the stored key and never signs in;
 * 3. without a terminal, it refuses with the command that signs in once;
 * 4. the vault token must store `name`; a build's must also read it, which
 *    is checked once it is stored.
 *
 * Only then does the developer sign in with Google, in a browser, through
 * `issue`, and the issued key is stored, read back, and deleted again if
 * storing it fails.
 * The vault is the only place a key is stored: the environment overrides
 * are read, never written.
 */
export const ensurePlayServiceAccount = async ({
  name,
  packageName,
  env = {},
  read = false,
  environment = true,
  issue = issuePlayServiceAccount,
}: {
  /** The vault secret builds resolve, `play-service-account`. */
  name: string;
  /** The app's package name, as the config sets it, which the prompt offers. */
  packageName?: string;
  /** Environment values read after `process.env`, such as `.env.hotupdater`'s. */
  env?: Readonly<Record<string, string>>;
  /** The caller resolves the key after this, so the token must read it back. */
  read?: boolean;
  /** An environment override of play-service-account counts as the key. */
  environment?: boolean;
  /** The sign-in that issues the key, android-helper's unless set. */
  issue?: IssuePlayServiceAccount;
}): Promise<EnsurePlayServiceAccountResult> => {
  const overrides = CREDENTIAL_ENV_NAMES["play-service-account"]
    .flat()
    .filter((variable) => getHotUpdaterEnvValue(env, variable) !== undefined);
  if (environment && overrides.length > 0) {
    return { status: "environment" };
  }

  // Read as the vault commands read it, with .env.hotupdater.
  const fileEnv = { ...(await readLoadedHotUpdaterEnv(getCwd())), ...env };
  const connection = readVaultConnection(fileEnv);
  if (!connection.ok) {
    throw new Error(
      `${name} is a Play service account, which Hot Updater issues when you sign in with Google and keeps in the Console's vault, and ${connection.missing.join(" and ")} ${connection.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} (a token that may write ${name}), or set ${CREDENTIAL_ENV_NAMES["play-service-account"][0].join(" or ")} to use a key you already have.`,
    );
  }
  const client = createVaultClient(connection.connection);
  const existing = (await client.list()).find((secret) => secret.name === name);
  if (existing?.kind === "play-service-account") {
    return { status: "stored", version: existing.version };
  }
  if (existing) {
    throw new Error(
      `The vault's ${name} is a ${existing.kind}, not a play-service-account: remove ${name} in the Console, then run this again.`,
    );
  }

  if (
    !canPrompt(
      `${name} is not in the vault yet. Hot Updater issues it when you sign in with Google, which needs a terminal.`,
      `Run \`${playServiceAccountSetupCommand(name)}\` in a terminal once, and builds use the stored key, also`,
    )
  ) {
    throw new PlayServiceAccountRefusedError(
      `${name} is not in the vault, and there is no terminal to sign in with Google.`,
    );
  }

  await assertWritable(client, name);

  const app = answered(
    await p.text({
      message: "The app's package name in Google Play",
      ...(packageName
        ? { initialValue: packageName, placeholder: packageName }
        : { placeholder: "com.example.app" }),
      validate: (value) =>
        PACKAGE_NAME_PATTERN.test(value?.trim() ?? "")
          ? undefined
          : "Enter a package name, such as com.example.app.",
    }),
  ).trim();

  p.log.info(
    "Sign in with Google in your browser, as a Play Console admin. Google's own page asks for the password; Hot Updater keeps only the service account key it creates.",
  );
  const oauthClient = oauthClientOverride(fileEnv);
  const issued = await issue({
    packageName: app,
    ...(oauthClient ? { oauthClient } : {}),
    onSignInUrl: async (url) => {
      p.log.message(
        ui.line(["If the browser does not open, open", ui.path(url)]),
      );
      await open(url).catch(() => {});
    },
    askDeveloperId: async () =>
      answered(
        await p.text({
          message: "Your Play Console developer account ID",
          placeholder: `the number after /developers/ in ${PLAY_CONSOLE_URL}'s address, or that address`,
          validate: (value) =>
            /^\s*\d+\s*$/u.test(value ?? "") ||
            /\/developers\/\d+/u.test(value ?? "")
              ? undefined
              : "Enter the number after /developers/ in Play Console's address, or paste the address.",
        }),
      ),
    chooseProject: async (projects) => {
      const choice = answered(
        await p.select<string>({
          message: "Google Cloud project to create the service account in",
          options: [
            ...projects.map((project) => ({
              value: project.projectId,
              label: project.projectId,
              ...(project.displayName &&
              project.displayName !== project.projectId
                ? { hint: project.displayName }
                : {}),
            })),
            { value: "", label: "Create a new project" },
          ],
        }),
      );
      return choice || undefined;
    },
    onStep: (message) => p.log.step(message),
  });

  try {
    const version = await storeIssued(client, name, issued);
    p.log.success(
      ui.block("Play service account stored", [
        ui.kv("Secret", name),
        ui.kv("Service account", issued.email),
        ui.kv("Project", issued.projectId),
        ui.kv("Version", ui.version(`v${version}`)),
      ]),
    );
    // The key is good whether or not this token reads it: it stays.
    if (read) await assertReadable(client, name, version);
    return { status: "issued", email: issued.email, version };
  } finally {
    await issued.dispose();
  }
};

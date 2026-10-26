import {
  GOOGLE_OAUTH_CLIENT_ENV_NAMES,
  type GoogleOAuthClient,
  type IssuedPlayServiceAccount,
  type IssuePlayServiceAccount,
  issuePlayServiceAccount,
  PLAY_CONSOLE_URL,
} from "@hot-updater/android-helper";
import {
  describeSecret,
  describeStoredSecret,
  getHotUpdaterEnvValue,
  p,
  registerCredentialValue,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import open from "open";

import { ui } from "../cli-ui";
import type { CreateGitHubSecrets } from "./githubSecret";
import {
  CredentialNotStoredError,
  CredentialSetupRefusedError,
  type IssuedCredentialPolicy,
  keepIssuedCopy,
  offerIssuedKeyToGitHub,
  prepareIssuedCredential,
  storeIssuedCredential,
  type WritableSecrets,
} from "./issuedCredential";

/** Where a project's service accounts, and each one's keys, are in Google Cloud. */
export const serviceAccountKeysUrl = (projectId: string) =>
  `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`;

const POLICY: IssuedCredentialPolicy = {
  kind: "play-service-account",
  what: "a Play service account",
  label: "Play service account",
  signIn: "Google",
  account: "Google Account",
};

export type EnsurePlayServiceAccountResult =
  /** The environment overrides the service account: the secrets adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter holds the service account already: no sign-in. */
  | { readonly status: "stored" }
  /** The key was issued with a Google sign-in and stored. */
  | {
      readonly status: "issued";
      readonly email: string;
      /**
       * Set when the adapter does not read the key back here, such as a
       * write-only store: the adapter this run reads it with, from a copy.
       */
      readonly secrets?: SecretsAdapter;
    };

const PACKAGE_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

/** Throws `CredentialSetupRefusedError` for a cancelled prompt. */
const answered = <T>(answer: T | symbol): T => {
  if (p.isCancel(answer)) {
    throw new CredentialSetupRefusedError(
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
 * Stores `issued` as `name`, the service account's own JSON, and reads it
 * back. The key is deleted again only when the adapter surely does not
 * hold it; one it may hold is kept, since deleting it would leave the store
 * with a dead key, and the message says which.
 */
/** Deletes the key, which surely is stored nowhere, and says so. */
const revokeNotStored = async (
  issued: IssuedPlayServiceAccount,
  reason: string,
  error: CredentialNotStoredError,
): Promise<never> => {
  const revoked = await issued.revoke();
  const keys = serviceAccountKeysUrl(issued.projectId);
  throw new Error(
    [
      reason,
      revoked
        ? `The key ${issued.keyId} was deleted again.`
        : `Deleting the key ${issued.keyId} failed: delete it under the service account's keys at ${keys}.`,
      `The service account ${issued.email} and its Play Console access remain, and the next run reuses them.`,
    ].join("\n"),
    { cause: error.cause },
  );
};

const storeIssued = async (
  secrets: WritableSecrets,
  name: string,
  issued: IssuedPlayServiceAccount,
): Promise<{ readonly readable: boolean }> => {
  // Masked before it is sent, so no failure can print it.
  registerCredentialValue(issued.json);
  try {
    return await storeIssuedCredential({
      secrets,
      name,
      value: issued.json,
    });
  } catch (error) {
    if (error instanceof CredentialNotStoredError) {
      await revokeNotStored(
        issued,
        `The ${secrets.name} secrets adapter did not store ${name}: ${error.message}`,
        error,
      );
    }
    throw new Error(
      `Hot Updater could not confirm that the ${secrets.name} secrets adapter stored ${name}: ${errorText(error)}\nThe key ${issued.keyId} is kept. Check ${describeSecret(secrets, name)}: when it holds the key, run the build again; when it does not, delete the key under the service account ${issued.email} in Google Cloud, then run this again.`,
      { cause: error },
    );
  }
};

/**
 * Makes sure a Play service account named `name` exists where builds
 * resolve it, issuing one when it does not. Everything that can fail is
 * checked before any Google sign-in, in this order:
 *
 * 1. an environment override of play-service-account
 *    (`HOT_UPDATER_PLAY_SERVICE_ACCOUNT_*`) is used as it is;
 * 2. a value the config's `secrets` adapter, or `localSecrets()`'s store,
 *    holds as `name` is used as it is, so CI uploads with the stored key
 *    and never signs in;
 * 3. without a terminal, it refuses with the command that signs in once.
 *
 * Only then does the developer sign in with Google, in a browser, through
 * `issue`, and the issued key is stored through the config's adapter, or
 * `localSecrets()`'s store by default, read back, and deleted again if
 * storing it fails. A key the default store keeps comes with an offer to
 * store it as a GitHub Actions secret too, and every issued key with where
 * to delete the ones no machine uses anymore. The environment overrides
 * are read, never written.
 */
export const ensurePlayServiceAccount = async ({
  name,
  packageName,
  env = {},
  replace,
  replacing,
  secrets,
  githubSecrets,
  issue = issuePlayServiceAccount,
}: {
  /** The secret builds resolve, `play-service-account`. */
  name: string;
  /** The app's package name, as the config sets it, which the prompt offers. */
  packageName?: string;
  /** Environment values read after `process.env`, such as `.env.hotupdater`'s. */
  env?: Readonly<Record<string, string>>;
  /** The adapter the key is read from and stored in, the config's by default. */
  secrets?: SecretsAdapter;
  /** Set by `secrets issue`: a key is issued whatever the adapter holds. */
  replace?: boolean;
  /** Set by `secrets issue --replace` when the adapter holds a key it replaces. */
  replacing?: boolean;
  /** The adapter that stores a key the default store keeps as a GitHub Actions secret. */
  githubSecrets?: CreateGitHubSecrets;
  /** The sign-in that issues the key, android-helper's unless set. */
  issue?: IssuePlayServiceAccount;
}): Promise<EnsurePlayServiceAccountResult> => {
  const prepared = await prepareIssuedCredential(POLICY, {
    name,
    env,
    replace,
    replacing,
    ...(secrets ? { secrets } : {}),
  });
  if (prepared.status !== "missing") return prepared;
  const { secrets: store, env: fileEnv } = prepared;

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
    const { readable } = await storeIssued(store, name, issued);
    p.log.success(
      ui.block("Play service account stored", [
        ui.kv("Secret", name),
        ui.kv("In", describeStoredSecret(store, name)),
        ui.kv("Service account", issued.email),
        ui.kv("Project", issued.projectId),
        ui.kv("Key ID", issued.keyId),
        `    Each machine that signs in creates its own key. Delete the ones no machine or CI uses anymore under the service account's keys at ${serviceAccountKeysUrl(issued.projectId)}.`,
      ]),
    );
    await offerIssuedKeyToGitHub({
      name,
      value: issued.json,
      secrets: store,
      ...(githubSecrets ? { githubSecrets } : {}),
    });
    if (readable) return { status: "issued", email: issued.email };
    // The adapter keeps the key, which builds here would not find.
    return {
      status: "issued",
      email: issued.email,
      secrets: await keepIssuedCopy({
        policy: POLICY,
        name,
        value: issued.json,
        secrets: store,
      }),
    };
  } finally {
    await issued.dispose();
  }
};

import {
  GOOGLE_OAUTH_CLIENT_ENV_NAMES,
  type GoogleOAuthClient,
  type IssuedPlayServiceAccount,
  type IssuePlayServiceAccount,
  issuePlayServiceAccount,
  PLAY_CONSOLE_URL,
} from "@hot-updater/android-helper";
import { getHotUpdaterEnvValue, p } from "@hot-updater/cli-tools";
import open from "open";

import { ui } from "../cli-ui";
import {
  assertReadableCredential,
  CredentialNotStoredError,
  CredentialSetupRefusedError,
  credentialSetupCommand,
  type IssuedCredentialPolicy,
  prepareIssuedCredential,
  storeIssuedCredential,
} from "./issuedCredential";

/** The command that signs in once, in a terminal, and stores the key. */
export const playServiceAccountSetupCommand = (name: string) =>
  credentialSetupCommand(name, "play-service-account");

const POLICY: IssuedCredentialPolicy = {
  kind: "play-service-account",
  what: "a Play service account",
  signIn: "Google",
  otherKindFix: (name) => `remove ${name} in the Console, then run this again.`,
};

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
 * Stores `issued` as `name`, and reads it back: the vault must list it as
 * the service account just issued. The key is deleted again only when the
 * vault does not hold it; one the vault may hold is kept, since deleting it
 * would leave the vault with a dead key, and the message says which.
 */
const storeIssued = async (
  client: Parameters<typeof storeIssuedCredential>[0]["client"],
  name: string,
  issued: IssuedPlayServiceAccount,
): Promise<number> => {
  try {
    return await storeIssuedCredential({
      client,
      name,
      kind: "play-service-account",
      value: {
        serviceAccount: Buffer.from(issued.json, "utf-8").toString("base64"),
      },
      isIssued: (listed) => listed.metadata["clientEmail"] === issued.email,
    });
  } catch (error) {
    if (error instanceof CredentialNotStoredError) {
      const revoked = await issued.revoke();
      const keys = `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${issued.projectId}`;
      throw new Error(
        [
          `The vault did not store ${name}: ${error.message}`,
          revoked
            ? `The key ${issued.keyId} was deleted again.`
            : `Deleting the key ${issued.keyId} failed: delete it under the service account's keys at ${keys}.`,
          `The service account ${issued.email} and its Play Console access remain, and the next run reuses them.`,
        ].join("\n"),
        { cause: error.cause },
      );
    }
    throw new Error(
      `Hot Updater could not confirm that the vault stored ${name}: ${errorText(error)}\nThe key ${issued.keyId} is kept. Run \`npx hot-updater secrets list\`: when ${name} is listed, run the build again; when it is not, delete the key under the service account ${issued.email} in Google Cloud, then run this again.`,
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
  const prepared = await prepareIssuedCredential(POLICY, {
    name,
    env,
    environment,
  });
  if (prepared.status !== "missing") return prepared;
  const { client, env: fileEnv } = prepared;

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
    if (read) {
      await assertReadableCredential({
        client,
        name,
        kind: "play-service-account",
        version,
        usage: "the build uploads with",
      });
    }
    return { status: "issued", email: issued.email, version };
  } finally {
    await issued.dispose();
  }
};

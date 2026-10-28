import {
  type IssuedPlayServiceAccount,
  type IssuePlayServiceAccount,
  issuePlayServiceAccount,
} from "@hot-updater/android-helper";
import {
  describeStoredSecret,
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
  offerIssuedKeyToGitHub,
  prepareIssuedCredential,
  storeIssuedCredential,
  withIssuedValue,
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
      /** The adapter the rest of this run reads with: the key from memory. */
      readonly secrets: SecretsAdapter;
    };

/** The project choice that creates one: no project ID is empty. */
const NEW_PROJECT = "";

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

/**
 * The app's package name in Google Play: the config's one as the answer to
 * confirm, a choice among several, or typed when the config declares none.
 */
const askPackageName = async (declared: readonly string[]): Promise<string> => {
  const message = "The app's package name in Google Play";
  if (declared.length > 1) {
    const choice = answered(
      await p.select<string>({
        message,
        options: [
          ...declared.map((name) => ({ value: name, label: name })),
          { value: "", label: "Another package name" },
        ],
      }),
    );
    if (choice) return choice;
  }
  const [only] = declared.length === 1 ? declared : [];
  return answered(
    await p.text({
      message,
      ...(only
        ? { initialValue: only, placeholder: only }
        : { placeholder: "com.example.app" }),
      validate: (value) =>
        PACKAGE_NAME_PATTERN.test(value?.trim() ?? "")
          ? undefined
          : "Enter a package name, such as com.example.app.",
    }),
  ).trim();
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Stores `issued` as `name`, the service account's own JSON, and reads it
 * back. The key is deleted again when the adapter does not read it back as
 * stored; one a failed write may have stored is kept, since deleting it
 * would leave the store with a dead key, and the message says which.
 */
/** Deletes the key, which the adapter does not hold, and says so. */
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
        ? `The key ${issued.keyId} was deleted; the next run reuses ${issued.email}.`
        : `Delete the key ${issued.keyId} at:\n${keys}`,
    ].join("\n"),
    { cause: error.cause },
  );
};

const storeIssued = async (
  secrets: SecretsAdapter,
  name: string,
  issued: IssuedPlayServiceAccount,
): Promise<void> => {
  // Masked before it is sent, so no failure can print it.
  registerCredentialValue(issued.json);
  try {
    await storeIssuedCredential({
      secrets,
      name,
      value: issued.json,
    });
  } catch (error) {
    if (error instanceof CredentialNotStoredError) {
      await revokeNotStored(
        issued,
        `The ${secrets.name} secrets adapter didn't store ${name}.\n${error.message}`,
        error,
      );
    }
    throw new Error(
      [
        `Couldn't confirm the ${secrets.name} secrets adapter stored ${name}.`,
        errorText(error),
        `If ${ui.fitPath(describeStoredSecret(secrets, name))} lacks key ${issued.keyId}, delete it at:`,
        serviceAccountKeysUrl(issued.projectId),
      ].join("\n"),
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
 * 2. a value the config's `secrets` adapter holds as `name` is used as it
 *    is, so CI uploads with the stored key and never signs in;
 * 3. without a terminal, it refuses with the command that signs in once.
 *
 * Only then, once gcloud is found, does it ask for the package name, and
 * the developer sign in with Google, through gcloud, and
 * invite the service account in Play Console, which opens in a browser,
 * through `issue`, and the issued key is stored through the config's
 * adapter, or `localSecrets()` by default, read back, and deleted again
 * unless the adapter reads back exactly that key. A key `localSecrets()`
 * keeps comes with an offer to store it as a GitHub Actions secret too, and
 * every issued key with where to delete the ones no machine uses anymore.
 * The environment overrides
 * are read, never written.
 */
export const ensurePlayServiceAccount = async ({
  name,
  packageNames = [],
  env = {},
  replace,
  replacing,
  secrets,
  githubSecrets,
  issue = issuePlayServiceAccount,
}: {
  /** The secret builds resolve, `play-service-account`. */
  name: string;
  /**
   * The package names the config's `nativeBuild.android` schemes declare,
   * which the prompt offers: one as its answer, several as a choice.
   */
  packageNames?: readonly string[];
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
  const { secrets: store } = prepared;

  // Asked once the sign-in's tool is found, so a missing gcloud stops first.
  let app = "";
  const issued = await issue({
    askPackageName: async () =>
      (app = await askPackageName([...new Set(packageNames)])),
    onInvite: async (url, email) => {
      p.log.info(
        `In Play Console, invite with release access to ${app}:\n${email}`,
      );
      p.log.message(`If the browser doesn't open, open:\n${ui.path(url)}`);
      await open(url).catch(() => {});
    },
    chooseProject: async (projects) => {
      // Those with the Play Developer API first, the likely answers.
      const sorted = [
        ...projects.filter(({ playApiEnabled }) => playApiEnabled),
        ...projects.filter(({ playApiEnabled }) => !playApiEnabled),
      ];
      const choice = answered(
        await p.select<string>({
          message: "Google Cloud project for the service account",
          options: [
            ...sorted.map(({ projectId, displayName, playApiEnabled }) => {
              const hint = [
                displayName !== projectId && displayName,
                playApiEnabled && "Play API enabled",
              ].filter(Boolean);
              return {
                value: projectId,
                label: projectId,
                ...(hint.length > 0 ? { hint: hint.join(", ") } : {}),
              };
            }),
            { value: NEW_PROJECT, label: "Create a new project" },
          ],
          initialValue: sorted[0]?.playApiEnabled
            ? sorted[0].projectId
            : NEW_PROJECT,
        }),
      );
      return choice === NEW_PROJECT ? null : choice;
    },
    onStep: (message) => p.log.step(message),
  });

  try {
    await storeIssued(store, name, issued);
    p.log.success(
      ui.block("Play service account stored", [
        name !== POLICY.kind && ui.kv("Name", name),
        ui.kv("Service account", issued.email),
        ui.kv("Key ID", issued.keyId),
        ui.kv("Source", ui.fitPath(describeStoredSecret(store, name))),
      ]),
    );
    await offerIssuedKeyToGitHub({
      name,
      value: issued.json,
      secrets: store,
      ...(githubSecrets ? { githubSecrets } : {}),
    });
    // This run reads the key from memory; builds after it, from the adapter.
    return {
      status: "issued",
      email: issued.email,
      secrets: withIssuedValue(store, name, issued.json),
    };
  } finally {
    await issued.dispose();
  }
};

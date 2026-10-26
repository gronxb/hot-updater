import {
  ASC_INTEGRATIONS_URL,
  type IssueAscApiKey,
  type IssuedAscApiKey,
  issueAscApiKey,
} from "@hot-updater/apple-helper";
import {
  describeSecret,
  describeStoredSecret,
  p,
  registerCredentialValue,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

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

const POLICY: IssuedCredentialPolicy = {
  kind: "asc-api-key",
  what: "an App Store Connect API key",
  label: "App Store Connect API key",
  signIn: "your Apple Account",
  account: "Apple Account",
};

/**
 * The key was issued but the secrets adapter does not hold it. `revoked` says whether
 * it was revoked again, so nothing is left behind; when it is false, the
 * message names the key to revoke in App Store Connect.
 */
export class AscApiKeyNotStoredError extends Error {
  readonly keyId: string;
  readonly revoked: boolean;
  constructor(
    message: string,
    keyId: string,
    revoked: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AscApiKeyNotStoredError";
    this.keyId = keyId;
    this.revoked = revoked;
  }
}

/**
 * The role of every key Hot Updater issues. A team key can't carry the
 * per-user "Access to Cloud Managed Distribution Certificate" permission, so
 * Xcode's cloud-managed signing (`-allowProvisioningUpdates` with
 * `-authenticationKey*`) works only with an Admin key; Developer and App
 * Manager keys fail it. Admin also uploads builds to TestFlight. EAS and asc
 * both default to it.
 */
const KEY_ROLE = "ADMIN";

export type EnsureAscApiKeyResult =
  /** The environment overrides the key: the secrets adapter is not read. */
  | { readonly status: "environment" }
  /** The secrets adapter holds the key already: no sign-in. */
  | { readonly status: "stored" }
  /** The key was issued with an Apple Account sign-in and stored. */
  | {
      readonly status: "issued";
      readonly keyId: string;
      /**
       * Set when the adapter does not read the key back here, such as a
       * write-only store: the adapter this run reads it with, from a copy.
       */
      readonly secrets?: SecretsAdapter;
    };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The issued key's name in App Store Connect, `hot-updater <date>`. App Store
 * Connect refuses a long key name (ENTITY_ERROR.ATTRIBUTE.INVALID.TOO_LONG for
 * 48 characters), so it carries no bundle identifier, whose length the app
 * picks: a team key serves every app in the team anyway.
 */
const issuedKeyName = () => `hot-updater ${today()}`;

/** Throws `CredentialSetupRefusedError` for a cancelled prompt. */
const answered = <T>(answer: T | symbol): T => {
  if (p.isCancel(answer)) {
    throw new CredentialSetupRefusedError(
      "Setting up the App Store Connect API key was cancelled.",
    );
  }
  return answer as T;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Stores `key` as `name`, one JSON value `{"keyId","issuerId","p8"}`, and
 * reads it back. The key is revoked again, with the session it was issued
 * in, only when the adapter surely does not hold it; one it may hold is
 * kept, since revoking it would leave the store with a dead key.
 */
const storedValue = (key: IssuedAscApiKey) =>
  JSON.stringify({ keyId: key.keyId, issuerId: key.issuerId, p8: key.p8 });

/** Revokes `key`, which surely is stored nowhere, and says so. */
const revokeNotStored = async (
  key: IssuedAscApiKey,
  error: CredentialNotStoredError,
): Promise<never> => {
  const revoked = await key.revoke().catch(() => false);
  throw new AscApiKeyNotStoredError(
    revoked
      ? `The App Store Connect API key ${key.keyId} was not stored, so it was revoked again: ${error.message}`
      : `The App Store Connect API key ${key.keyId} was not stored, and revoking it failed: revoke ${key.keyId} at ${ASC_INTEGRATIONS_URL}. ${error.message}`,
    key.keyId,
    revoked,
    { cause: error },
  );
};

const storeIssued = async (
  secrets: WritableSecrets,
  name: string,
  key: IssuedAscApiKey,
): Promise<{ readonly readable: boolean }> => {
  const value = storedValue(key);
  // Masked before it is sent, so no failure can print it.
  registerCredentialValue(value);
  try {
    return await storeIssuedCredential({
      secrets,
      name,
      value,
    });
  } catch (error) {
    if (error instanceof CredentialNotStoredError) {
      await revokeNotStored(key, error);
    }
    throw new Error(
      `Hot Updater could not confirm that the ${secrets.name} secrets adapter stored ${name}: ${errorText(error)}\nThe key ${key.keyId} is kept. Check ${describeSecret(secrets, name)}: when it holds the key, run the build again; when it does not, revoke ${key.keyId} at ${ASC_INTEGRATIONS_URL}, then run this again.`,
      { cause: error },
    );
  }
};

/**
 * Makes sure an App Store Connect API key named `name` exists where builds
 * resolve it, issuing one when it does not. Everything that can fail is
 * checked before any Apple sign-in (`prepareIssuedCredential`): an
 * environment override or a stored key is used as it is, and a run without
 * a terminal refuses with the command that signs in once.
 *
 * Only then does the developer sign in with their Apple Account, through
 * `issue`, and the issued key is stored through the config's adapter, or
 * `local()`'s store by default, read back, and revoked with the
 * same session if nothing holds it. A key the default store keeps comes
 * with an offer to store it as a GitHub Actions secret too, and every
 * issued key with where to revoke the ones no machine uses anymore.
 */
export const ensureAscApiKey = async ({
  name,
  env = {},
  replace,
  replacing,
  secrets,
  githubSecrets,
  issue = issueAscApiKey,
}: {
  /** The secret builds resolve, `asc-api-key` unless `signing.ascApiKey` names another. */
  name: string;
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
  /** How the key is issued after the Apple Account signs in. */
  issue?: IssueAscApiKey;
}): Promise<EnsureAscApiKeyResult> => {
  const prepared = await prepareIssuedCredential(POLICY, {
    name,
    env,
    replace,
    replacing,
    ...(secrets ? { secrets } : {}),
  });
  if (prepared.status !== "missing") return prepared;
  const store = prepared.secrets;

  const appleId = answered(
    await p.text({
      message: "Apple Account (email) to sign in to App Store Connect with",
      validate: (value) =>
        value?.trim() ? undefined : "Enter the Apple Account's email.",
    }),
  ).trim();

  const key = await issue({
    name: issuedKeyName(),
    role: KEY_ROLE,
    appleId,
    chooseTeam: async (team) => {
      const label = team.developerTeamId ?? team.teamId;
      if (!label) return undefined;
      const same = answered(
        await p.confirm({
          message: `Create the key in the team ${label}${team.appleId ? ` (${team.appleId})` : ""}?`,
        }),
      );
      if (same) return undefined;
      return answered(
        await p.text({
          message:
            "The team ID to create the key in, as App Store Connect shows it",
          validate: (value) =>
            value?.trim() ? undefined : "Enter the team's ID.",
        }),
      ).trim();
    },
  });
  try {
    const { readable } = await storeIssued(store, name, key);
    p.log.success(
      ui.block("App Store Connect API key stored", [
        ui.kv("Secret", name),
        ui.kv("In", describeStoredSecret(store, name)),
        ui.kv("Key ID", key.keyId),
        `    Each machine that signs in issues its own key. Revoke the ones no machine or CI uses anymore at ${ASC_INTEGRATIONS_URL} (Team Keys).`,
      ]),
    );
    await offerIssuedKeyToGitHub({
      name,
      value: storedValue(key),
      secrets: store,
      ...(githubSecrets ? { githubSecrets } : {}),
    });
    if (readable) return { status: "issued", keyId: key.keyId };
    // The adapter keeps the key, which builds here would not find.
    return {
      status: "issued",
      keyId: key.keyId,
      secrets: await keepIssuedCopy({
        policy: POLICY,
        name,
        value: storedValue(key),
        secrets: store,
      }),
    };
  } finally {
    await key.dispose();
  }
};

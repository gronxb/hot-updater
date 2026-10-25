import {
  ASC_INTEGRATIONS_URL,
  type IssueAscApiKey,
  type IssuedAscApiKey,
  issueAscApiKey,
} from "@hot-updater/apple-helper";
import { p } from "@hot-updater/cli-tools";

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
export const ascApiKeySetupCommand = (name: string) =>
  credentialSetupCommand(name, "asc-api-key");

const POLICY: IssuedCredentialPolicy = {
  kind: "asc-api-key",
  what: "an App Store Connect API key",
  signIn: "your Apple Account",
  otherKindFix: (name) =>
    `name the key differently with signing.ascApiKey, or remove ${name} in the Console.`,
};

/**
 * The key was issued but the vault does not hold it. `revoked` says whether
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
  /** The environment overrides the key: nothing is looked up in the vault. */
  | { readonly status: "environment" }
  /** The vault holds the key already: no sign-in. */
  | { readonly status: "stored"; readonly version: number }
  /** The key was issued with an Apple Account sign-in and stored. */
  | {
      readonly status: "issued";
      readonly keyId: string;
      readonly version: number;
    };

const today = () => new Date().toISOString().slice(0, 10);

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
 * Stores `key` as `name`, and reads it back: the vault must list it with
 * the key's IDs. The key is revoked again, with the session it was issued
 * in, only when the vault does not hold it; one the vault may hold is kept,
 * since revoking it would leave the vault with a dead key.
 */
const storeIssued = async (
  client: Parameters<typeof storeIssuedCredential>[0]["client"],
  name: string,
  key: IssuedAscApiKey,
): Promise<number> => {
  try {
    return await storeIssuedCredential({
      client,
      name,
      kind: "asc-api-key",
      value: {
        p8: Buffer.from(key.p8, "utf-8").toString("base64"),
        keyId: key.keyId,
        issuerId: key.issuerId,
      },
      isIssued: (listed) =>
        listed.metadata["keyId"] === key.keyId &&
        listed.metadata["issuerId"] === key.issuerId,
    });
  } catch (error) {
    if (error instanceof CredentialNotStoredError) {
      const revoked = await key.revoke().catch(() => false);
      throw new AscApiKeyNotStoredError(
        revoked
          ? `The App Store Connect API key ${key.keyId} was not stored, so it was revoked again: ${error.message}`
          : `The App Store Connect API key ${key.keyId} was not stored, and revoking it failed: revoke ${key.keyId} at ${ASC_INTEGRATIONS_URL}. ${error.message}`,
        key.keyId,
        revoked,
        { cause: error },
      );
    }
    throw new Error(
      `Hot Updater could not confirm that the vault stored ${name}: ${errorText(error)}\nThe key ${key.keyId} is kept. Run \`npx hot-updater secrets list\`: when ${name} is listed, run the build again; when it is not, revoke ${key.keyId} at ${ASC_INTEGRATIONS_URL}, then run this again.`,
      { cause: error },
    );
  }
};

/**
 * Makes sure an App Store Connect API key named `name` exists where builds
 * resolve it, issuing one when it does not. Everything that can fail is
 * checked before any Apple sign-in (`prepareIssuedCredential`): an
 * environment override or a stored key is used as it is, a run without a
 * terminal refuses with the command that signs in once, and the vault token
 * must be allowed to store `name`.
 *
 * Only then does the developer sign in with their Apple Account, through
 * `issue`, and the issued key is stored, read back, and revoked with the
 * same session if the vault does not hold it.
 */
export const ensureAscApiKey = async ({
  name,
  bundleIdentifier,
  env = {},
  read = false,
  environment = true,
  issue = issueAscApiKey,
}: {
  /** The vault secret builds resolve, `asc-api-key` unless `signing.ascApiKey` names another. */
  name: string;
  /** The app the key is named after in App Store Connect. */
  bundleIdentifier?: string;
  /** Environment values read after `process.env`, such as `.env.hotupdater`'s. */
  env?: Readonly<Record<string, string>>;
  /** The caller resolves the key after this, so the token must read it back. */
  read?: boolean;
  /** An environment override of asc-api-key counts as the key. */
  environment?: boolean;
  /** How the key is issued after the Apple Account signs in. */
  issue?: IssueAscApiKey;
}): Promise<EnsureAscApiKeyResult> => {
  const prepared = await prepareIssuedCredential(POLICY, {
    name,
    env,
    environment,
  });
  if (prepared.status !== "missing") return prepared;
  const { client } = prepared;

  const appleId = answered(
    await p.text({
      message: "Apple Account (email) to sign in to App Store Connect with",
      validate: (value) =>
        value?.trim() ? undefined : "Enter the Apple Account's email.",
    }),
  ).trim();

  const key = await issue({
    name: `hot-updater ${bundleIdentifier ?? name} ${today()}`,
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
    const version = await storeIssued(client, name, key);
    p.log.success(
      ui.block("App Store Connect API key stored", [
        ui.kv("Secret", name),
        ui.kv("Key ID", key.keyId),
        ui.kv("Issuer ID", key.issuerId),
        ui.kv("Version", ui.version(`v${version}`)),
      ]),
    );
    // The key is good whether or not this token reads it: it stays.
    if (read) {
      await assertReadableCredential({
        client,
        name,
        kind: "asc-api-key",
        version,
        usage: "the build signs and uploads with",
      });
    }
    return { status: "issued", keyId: key.keyId, version };
  } finally {
    await key.dispose();
  }
};
